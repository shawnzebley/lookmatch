// Local luminance-detail measurement and transfer for reference matching.
import { SRGB8_TO_LIN, linToLab, labToLin, linearToSrgb } from './color.js';

const CORE = 191;
const MIN_SUPPORT = 200;
const EPSILON = 1e-6;
const finite = Number.isFinite;

function validPlanes(ps) {
  return ps && Number.isInteger(ps.width) && ps.width > 0 && Number.isInteger(ps.height) && ps.height > 0 &&
    ps.n === ps.width * ps.height && ps.lr?.length >= ps.n && ps.lg?.length >= ps.n && ps.lb?.length >= ps.n;
}

/** P75 absolute 3x3 high-pass L* detail over pixels with a complete supported neighborhood. */
export function referenceDetailStats(ps, { mask = null } = {}) {
  if (!validPlanes(ps) || (mask && mask.length < ps.n)) return null;
  const { width: w, height: h, n } = ps;
  const L = new Float32Array(n);
  const usable = new Uint8Array(n);
  const lab = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (mask && mask[i] < CORE) continue;
    const r = ps.lr[i], g = ps.lg[i], b = ps.lb[i];
    if (![r, g, b].every(finite)) continue;
    linToLab(r, g, b, lab);
    if (!finite(lab[0])) continue;
    L[i] = Math.max(0, Math.min(100, lab[0])); usable[i] = 1;
  }
  const values = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!usable[i]) continue;
    let sum = 0, ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = i + dy * w + dx;
      if (!usable[j]) { ok = false; break; }
      sum += L[j];
    }
    if (ok) values.push(Math.abs(L[i] - sum / 9));
  }
  if (values.length < MIN_SUPPORT) return null;
  values.sort((a, b) => a - b);
  const p = 0.75 * (values.length - 1), lo = Math.floor(p), t = p - lo;
  return { n: values.length, detail: values[lo] + (values[Math.min(lo + 1, values.length - 1)] - values[lo]) * t };
}

/** Fit an interpolated target/source local-detail ratio. Flat or unsupported sources stay neutral. */
export function fitReferenceDetail(sourceStats, refStats, { strength = 1 } = {}) {
  if (!finite(strength)) return null;
  const amount = Math.max(0, Math.min(1, strength));
  if (amount === 0) return { gain: 1 };
  if (!sourceStats || !refStats || !finite(sourceStats.detail) || !finite(refStats.detail) ||
      !Number.isInteger(sourceStats.n) || sourceStats.n < MIN_SUPPORT ||
      !Number.isInteger(refStats.n) || refStats.n < MIN_SUPPORT || sourceStats.detail <= EPSILON || refStats.detail < 0) return null;
  const gain = 1 + amount * (refStats.detail / sourceStats.detail - 1);
  return finite(gain) ? { gain } : null;
}

function gamutMap(L, a, b, out) {
  labToLin(L, a, b, out);
  if ([out[0], out[1], out[2]].every((v) => finite(v) && v >= 0 && v <= 1)) return out;
  // Preserve fixed L* and hue by reducing chroma along the same Lab direction.
  let low = 0, high = 1;
  for (let k = 0; k < 28; k++) {
    const mid = (low + high) / 2;
    labToLin(L, a * mid, b * mid, out);
    if ([out[0], out[1], out[2]].every((v) => finite(v) && v >= 0 && v <= 1)) low = mid;
    else high = mid;
  }
  labToLin(L, a * low, b * low, out);
  for (let c = 0; c < 3; c++) out[c] = Math.max(0, Math.min(1, out[c]));
  return out;
}

/** Return a new RGBA/RGB byte buffer; the input is never modified. */
export function applyReferenceDetailRGBA(buf, width, height, detail, mask = null, ch = 4) {
  if (!buf || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 ||
      ![3, 4].includes(ch) || buf.length < width * height * ch || (mask && mask.length < width * height)) return null;
  const out = new Uint8ClampedArray(buf);
  const count = width * height;
  if (!detail || !count) return out;
  const gainAt = (i) => {
    if (finite(detail.gain)) return detail.gain;
    const m = mask?.[i] ?? 0;
    const s = finite(detail.subject?.gain) ? detail.subject.gain : 1;
    const b = finite(detail.background?.gain) ? detail.background.gain : 1;
    return b + (s - b) * Math.max(0, Math.min(255, m)) / 255;
  };
  const L = new Float32Array(count), A = new Float32Array(count), B = new Float32Array(count);
  const lab = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const o = i * ch;
    linToLab(SRGB8_TO_LIN[buf[o]], SRGB8_TO_LIN[buf[o + 1]], SRGB8_TO_LIN[buf[o + 2]], lab);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
  }
  const lin = [0, 0, 0];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, gain = gainAt(i);
    if (!finite(gain) || gain === 1) continue;
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.max(0, Math.min(width - 1, x + dx));
      const yy = Math.max(0, Math.min(height - 1, y + dy));
      sum += L[yy * width + xx];
    }
    const smooth = sum / 9;
    const nextL = Math.max(0, Math.min(100, smooth + gain * (L[i] - smooth)));
    gamutMap(nextL, A[i], B[i], lin);
    const o = i * ch;
    out[o] = Math.round(linearToSrgb(lin[0]) * 255);
    out[o + 1] = Math.round(linearToSrgb(lin[1]) * 255);
    out[o + 2] = Math.round(linearToSrgb(lin[2]) * 255);
  }
  return out;
}
