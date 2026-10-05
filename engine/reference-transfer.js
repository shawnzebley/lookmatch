// Reference-matched Lab distribution transfer. Operates on linear RGB planes from measure.js.
import { linToLab, labToLin } from './color.js';

const Q = 256;
const CORE = 191;
const HUE_SECTORS = 12;
const HUE_STEP = 360 / HUE_SECTORS;
const HUE_RADIUS = HUE_STEP;
const HUE_MIN_SUPPORT = 20;
const HUE_MIN_FRACTION = 0.005;
const HUE_MIN_CHROMA = 5;
const finite = Number.isFinite;

function hueDistance(a, b) { return ((a - b + 540) % 360) - 180; }

function hueMembership(hue, center, radius = HUE_RADIUS) {
  const x = Math.abs(hueDistance(hue, center)) / radius;
  return x >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
}
function smoothstep(lo, hi, value) {
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function quantiles(values) {
  values.sort((a, b) => a - b);
  const out = new Array(Q + 1);
  for (let k = 0; k <= Q; k++) {
    const p = k / Q * (values.length - 1), i = Math.floor(p), t = p - i;
    out[k] = values[i] + (values[Math.min(i + 1, values.length - 1)] - values[i]) * t;
  }
  return out;
}

/** Summarize linear RGB pixel planes. A mask includes pixels with byte value >= 191. */
export function referenceTransferStats(ps, { mask = null } = {}) {
  if (!ps || !Number.isInteger(ps.n) || ps.n <= 0 || !ps.lr || !ps.lg || !ps.lb ||
      ps.lr.length < ps.n || ps.lg.length < ps.n || ps.lb.length < ps.n ||
      (mask && mask.length < ps.n)) return null;
  const lab = [0, 0, 0], ls = [], as = [], bs = [];
  const sectors = Array.from({ length: HUE_SECTORS }, (_, i) => ({ center: i * HUE_STEP, weight: 0, a: 0, b: 0 }));
  let sa = 0, sb = 0, saa = 0, sbb = 0, n = 0;
  for (let i = 0; i < ps.n; i++) {
    if (mask && mask[i] < CORE) continue;
    const r = ps.lr[i], g = ps.lg[i], b = ps.lb[i];
    if (![r, g, b].every(finite)) continue;
    linToLab(r, g, b, lab);
    const L = Math.max(0, Math.min(100, lab[0])), a = lab[1], bb = lab[2];
    if (![L, a, bb].every(finite)) continue;
    ls.push(L); as.push(a); bs.push(bb); sa += a; sb += bb; saa += a * a; sbb += bb * bb; n++;
    const chroma = Math.hypot(a, bb);
    if (chroma >= HUE_MIN_CHROMA) {
      const hue = (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360;
      for (const sector of sectors) {
        const w = hueMembership(hue, sector.center);
        if (!w) continue;
        sector.weight += w; sector.a += a * w; sector.b += bb * w;
      }
    }
  }
  if (!n) return null;
  const ma = sa / n, mb = sb / n;
  const hueSectors = sectors.filter((s) => s.weight >= HUE_MIN_SUPPORT && s.weight / n >= HUE_MIN_FRACTION)
    .map((s) => ({ center: s.center, n: s.weight, mean: [s.a / s.weight, s.b / s.weight] }));
  return { version: 1, n, Lquantiles: quantiles(ls), mean: [ma, mb],
    std: [Math.sqrt(Math.max(0, saa / n - ma * ma)), Math.sqrt(Math.max(0, sbb / n - mb * mb))], hueSectors };
}

function valid(s) {
  return s?.version === 1 && Number.isInteger(s.n) && s.n > 0 &&
    Array.isArray(s.Lquantiles) && s.Lquantiles.length === Q + 1 && s.Lquantiles.every(finite) &&
    Array.isArray(s.mean) && s.mean.length === 2 && s.mean.every(finite) &&
    Array.isArray(s.std) && s.std.length === 2 && s.std.every((v) => finite(v) && v >= 0) &&
    (s.hueSectors === undefined || (Array.isArray(s.hueSectors) && s.hueSectors.every((x) =>
      finite(x.center) && x.center >= 0 && x.center < 360 && finite(x.n) && x.n >= HUE_MIN_SUPPORT &&
      Array.isArray(x.mean) && x.mean.length === 2 && x.mean.every(finite))));
}

/** Fit a smooth monotone L quantile curve and diagonal Lab chroma normalization. */
export function fitReferenceTransfer(sourceStats, refStats, { strength = 1, preserveColors = false } = {}) {
  if (!valid(sourceStats) || !valid(refStats) || !finite(strength)) return null;
  const amount = Math.max(0, Math.min(1, strength));
  const Lmap = sourceStats.Lquantiles.map((v, i) => v + (refStats.Lquantiles[i] - v) * amount);
  // Collapse tied source quantiles to their mean target rank so the fitted curve is
  // continuous on both sides of flat source histogram plateaus.
  for (let start = 0; start < Q;) {
    let end = start + 1;
    while (end <= Q && sourceStats.Lquantiles[end] === sourceStats.Lquantiles[start]) end++;
    if (end - start > 1) {
      const mean = Lmap.slice(start, end).reduce((sum, v) => sum + v, 0) / (end - start);
      for (let i = start; i < end; i++) Lmap[i] = mean;
    }
    start = end;
  }
  // Remove tiny numerical reversals while preserving a monotone mapping.
  for (let i = 1; i < Lmap.length; i++) Lmap[i] = Math.max(Lmap[i], Lmap[i - 1]);
  const scale = [0, 1].map((i) => {
    const s = sourceStats.std[i], t = refStats.std[i];
    return s > 1e-8 ? 1 + amount * (t / s - 1) : 1;
  });
  const srcSectors = new Map((sourceStats.hueSectors || []).map((s) => [s.center, s]));
  const refSectors = new Map((refStats.hueSectors || []).map((s) => [s.center, s]));
  const hueSectors = [];
  if (amount > 0) for (let i = 0; i < HUE_SECTORS; i++) {
    const center = i * HUE_STEP, src = srcSectors.get(center), ref = refSectors.get(center);
    if (!src || !ref) continue;
    const predicted = src.mean.map((v, c) =>
      sourceStats.mean[c] + (refStats.mean[c] - sourceStats.mean[c]) * amount + (v - sourceStats.mean[c]) * scale[c]);
    const desired = src.mean.map((v, c) => v + (ref.mean[c] - v) * amount);
    const weight = Math.min(1, Math.sqrt(Math.min(src.n / sourceStats.n, ref.n / refStats.n) / 0.02));
    hueSectors.push({ center, width: HUE_RADIUS, deltaA: desired[0] - predicted[0],
      deltaB: desired[1] - predicted[1], weight });
  }
  if (preserveColors) {
    // Automatic look matching should only move a color where both images contain
    // that hue. Keep unsupported colors exactly at their source a/b values.
    for (const sector of hueSectors) {
      const src = srcSectors.get(sector.center), ref = refSectors.get(sector.center);
      const sourceHue = Math.atan2(src.mean[1], src.mean[0]);
      const targetHue = Math.atan2(ref.mean[1], ref.mean[0]);
      let hueDelta = ((targetHue - sourceHue + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      hueDelta = Math.max(-25 * Math.PI / 180, Math.min(25 * Math.PI / 180, hueDelta * amount));
      const sourceChroma = Math.hypot(...src.mean), targetChroma = Math.hypot(...ref.mean);
      const ratio = sourceChroma > 1e-6 ? targetChroma / sourceChroma : 1;
      const chromaScale = 1 + (Math.max(0.7, Math.min(1.3, ratio)) - 1) * amount;
      const mappedHue = sourceHue + hueDelta, mappedChroma = sourceChroma * chromaScale;
      sector.deltaA = Math.cos(mappedHue) * mappedChroma - src.mean[0];
      sector.deltaB = Math.sin(mappedHue) * mappedChroma - src.mean[1];
    }
  }
  return { version: 1, strength: amount, identity: amount === 0, sourceL: [...sourceStats.Lquantiles], targetL: Lmap,
    sourceMean: [...sourceStats.mean], targetMean: preserveColors ? [...sourceStats.mean]
      : sourceStats.mean.map((v, i) => v + (refStats.mean[i] - v) * amount),
    abScale: preserveColors ? [1, 1] : scale, hueSectors, preserveColors };
}

function mapL(L, transform) {
  const src = transform.sourceL, dst = transform.targetL;
  if (L < src[0] - 1e-4) return dst[0] + (L - src[0]);
  if (L > src[Q] + 1e-4) return dst[Q] + (L - src[Q]);
  L = Math.max(src[0], Math.min(src[Q], L));
  // For a tied source plateau, use its mean target rank rather than an arbitrary edge.
  let first = 0, end = Q + 1;
  while (first < end) { const mid = (first + end) >> 1; if (src[mid] < L) first = mid + 1; else end = mid; }
  if (src[first] === L) {
    const start = first;
    end = Q + 1;
    while (first < end) { const mid = (first + end) >> 1; if (src[mid] <= L) first = mid + 1; else end = mid; }
    let sum = 0, count = 0;
    for (let i = start; i < first; i++) { sum += dst[i]; count++; }
    if (count) return sum / count;
  }
  let lo = 0, hi = Q;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (src[mid] <= L) lo = mid; else hi = mid; }
  const den = src[hi] - src[lo], t = den > 1e-12 ? (L - src[lo]) / den : 0;
  return dst[lo] + (dst[hi] - dst[lo]) * t;
}

// If Lab's requested chroma falls outside linear sRGB, binary-search chroma toward neutral.
// Keeping L fixed preserves lightness; scaling a,b together preserves hue.
function gamutMap(L, a, b, out) {
  labToLin(L, a, b, out);
  if ([out[0], out[1], out[2]].every((v) => finite(v) && v >= -1e-8 && v <= 1 + 1e-8)) {
    for (let i = 0; i < 3; i++) out[i] = Math.max(0, Math.min(1, out[i]));
    return out;
  }
  let low = 0, high = 1;
  for (let k = 0; k < 28; k++) {
    const mid = (low + high) * 0.5;
    labToLin(L, a * mid, b * mid, out);
    if ([out[0], out[1], out[2]].every((v) => finite(v) && v >= 0 && v <= 1)) low = mid;
    else high = mid;
  }
  labToLin(L, a * low, b * low, out);
  for (let i = 0; i < 3; i++) out[i] = Math.max(0, Math.min(1, out[i]));
  return out;
}

/** Apply to a linear RGB pixel; writes [r,g,b,L,a,b] into out and returns it. */
export function applyReferenceTransferLinear(r, g, b, transform, out = new Float64Array(6)) {
  if (!transform || transform.version !== 1 || ![r, g, b].every(finite)) return null;
  const lab = [0, 0, 0];
  linToLab(r, g, b, lab);
  if (transform.identity) {
    out[0] = r; out[1] = g; out[2] = b; out[3] = lab[0]; out[4] = lab[1]; out[5] = lab[2];
    return out;
  }
  let L = Math.max(0, Math.min(100, mapL(lab[0], transform)));
  let a = transform.targetMean[0] + (lab[1] - transform.sourceMean[0]) * transform.abScale[0];
  let bb = transform.targetMean[1] + (lab[2] - transform.sourceMean[1]) * transform.abScale[1];
  const originalChroma = Math.hypot(lab[1], lab[2]);
  let correspondence = 0;
  const chromaFade = transform.chromaFade
    ? smoothstep(transform.chromaFade[0], transform.chromaFade[1], originalChroma)
    : originalChroma >= HUE_MIN_CHROMA ? 1 : 0;
  if (chromaFade > 0 && transform.hueSectors?.length) {
    const hue = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360;
    let da = 0, db = 0, total = 0;
    for (const sector of transform.hueSectors) {
      const w = hueMembership(hue, sector.center) * sector.weight;
      if (!w) continue;
      correspondence += w;
      da += sector.deltaA * w; db += sector.deltaB * w; total += w;
    }
    // Missing adjacent sectors must fade to zero rather than jump at the sector boundary.
    if (total > 0) { a += chromaFade * da / Math.max(1, total); bb += chromaFade * db / Math.max(1, total); }
  }
  if (chromaFade > 0 && transform.bandCorrections?.length) {
    const hue = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360;
    let da = 0, db = 0, total = 0;
    for (const sector of transform.bandCorrections) {
      const w = hueMembership(hue, sector.center, sector.width) * sector.weight;
      if (!w) continue;
      correspondence += w;
      da += sector.deltaA * w; db += sector.deltaB * w; total += w;
    }
    if (total > 0) {
      const scale = 1 / Math.max(1, total);
      a += da * scale * chromaFade; bb += db * scale * chromaFade;
    }
  }
  if (transform.preserveColors && originalChroma >= HUE_MIN_CHROMA) {
    // No matching colored content means no target for this color's lightness
    // either. A neutral reference cannot turn a dark green shirt mint/white.
    if (correspondence === 0) { L = lab[0]; a = lab[1]; bb = lab[2]; }
    // A white reference's lightness can itself bleach a colored object during
    // gamut mapping. Limit automatic lightness before sacrificing its color.
    const requestedL = L, minimumChroma = originalChroma * 0.7;
    const candidate = new Float64Array(3), check = new Float64Array(3);
    const retainsColor = (lightness) => {
      gamutMap(lightness, a, bb, candidate);
      linToLab(candidate[0], candidate[1], candidate[2], check);
      return Math.hypot(check[1], check[2]) >= minimumChroma;
    };
    if (!retainsColor(requestedL)) {
      let safe = lab[0], unsafe = requestedL;
      // If a supported hue move is out of gamut even at the source lightness,
      // prefer its original color over silently neutralizing the object.
      if (!retainsColor(safe)) { a = lab[1]; bb = lab[2]; }
      for (let step = 0; step < 20; step++) {
        const mid = (safe + unsafe) / 2;
        if (retainsColor(mid)) safe = mid; else unsafe = mid;
      }
      L = safe;
    }
  }
  gamutMap(L, a, bb, out);
  const actualLab = linToLab(out[0], out[1], out[2], [0, 0, 0]);
  out[3] = actualLab[0]; out[4] = actualLab[1]; out[5] = actualLab[2];
  return out;
}
