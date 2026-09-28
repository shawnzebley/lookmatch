// Retouching that depends on where a pixel is, so it can't live in the LUT:
//   skin pass  - on the skin mask (facial + body skin from the people model): Texture and Clarity
//                (negative = smoother, like a Lightroom People mask with Texture/Clarity -8..-10) and
//                Skin tone (+ = more colour, reads as tanned; - = paler).
//   heal       - Lightroom-style Heal spots: copy a nearby patch, keep the spot's own light and colour
//                at its edge, fade the edge, mix by opacity (50-60 softens creases and under-eye bags,
//                100 removes a spot).
// Both run on 8-bit RGBA in output pixels. Radii scale with the output's long side, so the 1400 px
// preview and the full-size export look alike.
import { drawTransform, isIdentityGeom } from './geom.js';

// ---- params ------------------------------------------------------------------------------------
// p.skinTexture, p.skinClarity: -100..100 (0 = off). p.skinTone: -100 paler .. +100 tanned.
// p.heals: [{ x, y, r, sx, sy, op }] with x/y/sx/sy in 0..1 of the whole uncropped photo, r a fraction
// of the photo's long side, op 0..1.
export const SKIN_SMOOTH_DEFAULT = { skinTexture: -9, skinClarity: -5 };
export function hasSkinPass(p) { return !!(p && (p.skinTexture || p.skinClarity || p.skinTone)); }
export function hasHeals(p) { return !!(p && p.heals && p.heals.length); }
export function hasRetouch(p) { return hasSkinPass(p) || hasHeals(p); }

// fine (texture) and coarse (clarity) detail radii for an output whose long side is `long` px
export function skinRadii(long) { return [Math.max(1, Math.round(long * 0.0022)), Math.max(2, Math.round(long * 0.011))]; }
/** Rows of context a band needs above and below for the skin pass to match the whole-image result. */
export function skinHalo(long) { return 2 * skinRadii(long)[1] + 2; }

// box mean, radius r, separable running sums, edges normalised by the true window size
function boxMean(src, w, h, r, out = new Float32Array(w * h), tmp = new Float32Array(w * h)) {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    const r0 = Math.min(r, w - 1);
    for (let x = 0; x <= r0; x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      if (x > 0) { const hi = x + r, lo = x - r - 1; if (hi < w) s += src[o + hi]; if (lo >= 0) s -= src[o + lo]; }
      tmp[o + x] = s / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    const r0 = Math.min(r, h - 1);
    for (let y = 0; y <= r0; y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y > 0) { const hi = y + r, lo = y - r - 1; if (hi < h) s += tmp[hi * w + x]; if (lo >= 0) s -= tmp[lo * w + x]; }
      out[y * w + x] = s / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
    }
  }
  return out;
}
// two box passes ~ a soft (triangle) blur
function blur2(src, w, h, r) { const t = new Float32Array(w * h); return boxMean(boxMean(src, w, h, r, undefined, t), w, h, r, undefined, t); }

/**
 * Skin pass on rows already through the LUT. mask: Uint8Array (0..255 skin) the size of buf's rows.
 * long: the long side of the whole output (sets the detail radii). Only rows [core0, core1) are
 * written; the rest is context (a tile's halo).
 */
export function applySkinPass(buf, width, rows, p, mask, long, ch = 4, core0 = 0, core1 = rows) {
  if (!mask || !hasSkinPass(p)) return;
  const kT = Math.max(-1, Math.min(1, (p.skinTexture || 0) / 100));
  const kC = 0.7 * Math.max(-1, Math.min(1, (p.skinClarity || 0) / 100));
  const kS = 0.6 * Math.max(-1, Math.min(1, (p.skinTone || 0) / 100));
  // bounding box of skin in the core rows, grown by the context the blurs need
  let x0 = width, x1 = -1, y0 = rows, y1 = -1;
  for (let y = core0; y < core1; y++) {
    const o = y * width;
    for (let x = 0; x < width; x++) if (mask[o + x] > 3) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return;
  const [rT, rC] = skinRadii(long);
  const pad = (kT || kC) ? 2 * rC + 2 : 0;
  const bx0 = Math.max(0, x0 - pad), bx1 = Math.min(width - 1, x1 + pad), by0 = Math.max(0, y0 - pad), by1 = Math.min(rows - 1, y1 + pad);
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  const Y = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = ((by0 + y) * width + bx0 + x) * ch;
    Y[y * w + x] = (0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2]) / 255;
  }
  const bT = kT ? blur2(Y, w, h, rT) : null;
  const bC = kC ? blur2(Y, w, h, rC) : null;
  for (let y = Math.max(y0, core0); y <= Math.min(y1, core1 - 1); y++) {
    for (let x = x0; x <= x1; x++) {
      const m = mask[y * width + x];
      if (m <= 3) continue;
      const t = m / 255, j = (y - by0) * w + (x - bx0), o = (y * width + x) * ch;
      const v = Y[j];
      let d = 0;
      if (bT) d += kT * (v - bT[j]);
      if (bC) d += kC * 4 * v * (1 - v) * (v - bC[j]); // clarity: local contrast, weighted to the midtones
      d *= 255 * t;
      let r = buf[o] + d, g = buf[o + 1] + d, b = buf[o + 2] + d;
      if (kS) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b, s = 1 + kS * t;
        r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
      }
      buf[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
      buf[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5;
      buf[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5;
    }
  }
}

// ---- heal --------------------------------------------------------------------------------------
/** Photo px -> output px for an output that shows geometry g at `k` output px per photo px, first row oy. */
export function photoToOut(W, H, g, k = 1, oy = 0) {
  if (isIdentityGeom(g)) return (x, y) => [x * k, y * k - oy];
  const [a, b, c, d, e, f] = drawTransform(W, H, g, k, oy);
  return (x, y) => [a * x + c * y + e, b * x + d * y + f];
}

/** Heal spots in output px: { cx, cy, r, dx, dy, op } (dx/dy = source minus spot). */
export function healsToOut(heals, W, H, g, k = 1, oy = 0) {
  const T = photoToOut(W, H, g, k, oy), L = Math.max(W, H);
  return (heals || []).map((h) => {
    const [cx, cy] = T(h.x * W, h.y * H), [sx, sy] = T(h.sx * W, h.sy * H);
    return { cx, cy, r: Math.max(1.5, h.r * L * k), dx: sx - cx, dy: sy - cy, op: h.op ?? 1 };
  });
}

/** Box (output px, integers) a heal reads from or writes to. */
export function healBox(s, pad = 2) {
  const r = s.r + pad;
  return [Math.floor(Math.min(s.cx, s.cx + s.dx) - r), Math.floor(Math.min(s.cy, s.cy + s.dy) - r), Math.ceil(Math.max(s.cx, s.cx + s.dx) + r), Math.ceil(Math.max(s.cy, s.cy + s.dy) + r)];
}

const RING = 48;
/**
 * Heal spots into buf (width x rows, ch channels) in order; spot coords are in buf's px.
 * Inside each spot: source pixel + the colour difference between spot and source measured on the
 * spot's edge, spread inward (inverse-distance), so the patch takes the spot's light and tone.
 */
export function healBuffer(buf, width, rows, spots, ch = 4) {
  const px = (x, y, c) => {
    x = x < 0 ? 0 : x >= width ? width - 1 : x | 0; y = y < 0 ? 0 : y >= rows ? rows - 1 : y | 0;
    return buf[(y * width + x) * ch + c];
  };
  // 3x3 mean, for steadier edge samples
  const avg = (x, y, c) => { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += px(x + i, y + j, c); return s / 9; };
  for (const s of spots) {
    if (!(s.op > 0)) continue;
    const R = s.r, ring = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * 2 * Math.PI, ux = s.cx + Math.cos(a) * R, uy = s.cy + Math.sin(a) * R;
      ring.push([ux, uy, [0, 1, 2].map((c) => avg(ux, uy, c) - avg(ux + s.dx, uy + s.dy, c))]);
    }
    const x0 = Math.max(0, Math.floor(s.cx - R)), x1 = Math.min(width - 1, Math.ceil(s.cx + R));
    const y0 = Math.max(0, Math.floor(s.cy - R)), y1 = Math.min(rows - 1, Math.ceil(s.cy + R));
    if (x1 < x0 || y1 < y0) continue;
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dd = Math.hypot(x + 0.5 - s.cx, y + 0.5 - s.cy) / R;
      if (dd >= 1) continue;
      const fe = dd < 0.7 ? 1 : 1 - (dd - 0.7) / 0.3, a = s.op * fe * fe * (3 - 2 * fe);
      let wS = 0; const df = [0, 0, 0];
      for (const [ux, uy, d] of ring) { const q = 1 / ((x + 0.5 - ux) ** 2 + (y + 0.5 - uy) ** 2 + 1); wS += q; df[0] += q * d[0]; df[1] += q * d[1]; df[2] += q * d[2]; }
      const o = (y * width + x) * ch, v = [0, 0, 0];
      for (let c = 0; c < 3; c++) { const h = px(x + s.dx, y + s.dy, c) + df[c] / wS; v[c] = buf[o + c] + (h - buf[o + c]) * a; }
      out.push(o, v);
    }
    // write after reading, so a spot never copies its own half-healed pixels
    for (let i = 0; i < out.length; i += 2) { const o = out[i], v = out[i + 1]; for (let c = 0; c < 3; c++) buf[o + c] = v[c] < 0 ? 0 : v[c] > 255 ? 255 : v[c] + 0.5; }
  }
}

/**
 * Where to copy from for a new spot at (cx, cy) radius r (buf px). Tries rings of candidates around the
 * spot and keeps the one whose edge looks most like the spot's edge (brightness, colour, texture), with
 * a lean toward below: the spot's surroundings, not the spot, are what should match.
 */
export function pickHealSource(buf, width, rows, cx, cy, r, ch = 4, mask = null) {
  const stats = (x0, y0) => {
    let n = 0; const m = [0, 0, 0], q = [0, 0, 0];
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * 2 * Math.PI;
      for (const f of [1.05, 1.3]) {
        const x = Math.round(x0 + Math.cos(a) * r * f), y = Math.round(y0 + Math.sin(a) * r * f);
        if (x < 0 || y < 0 || x >= width || y >= rows) return null;
        const o = (y * width + x) * ch;
        for (let c = 0; c < 3; c++) { m[c] += buf[o + c]; q[c] += buf[o + c] ** 2; }
        n++;
      }
    }
    return m.map((v, c) => [v / n, Math.sqrt(Math.max(0, q[c] / n - (v / n) ** 2))]);
  };
  const inner = (x0, y0) => { // the patch that gets copied: its own spread (a pimple there would be copied in)
    let n = 0, s = 0, s2 = 0;
    for (let y = -r; y <= r; y += Math.max(1, r / 6)) for (let x = -r; x <= r; x += Math.max(1, r / 6)) {
      if (x * x + y * y > r * r) continue;
      const X = Math.round(x0 + x), Y = Math.round(y0 + y);
      if (X < 0 || Y < 0 || X >= width || Y >= rows) return Infinity;
      const o = (Y * width + X) * ch, l = 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2];
      s += l; s2 += l * l; n++;
    }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  };
  const want = stats(cx, cy);
  let best = null;
  for (const dist of [2.2, 3, 4]) for (let k = 0; k < 16; k++) {
    const a = (k / 16) * 2 * Math.PI, x = cx + Math.cos(a) * r * dist, y = cy + Math.sin(a) * r * dist;
    const got = stats(x, y);
    if (!got) continue;
    let cost = 0;
    for (let c = 0; c < 3; c++) cost += Math.abs(got[c][0] - (want ? want[c][0] : got[c][0])) + 0.7 * Math.abs(got[c][1] - (want ? want[c][1] : got[c][1]));
    cost += 0.5 * inner(x, y);
    cost *= 1 + 0.25 * (1 - Math.sin(a)) + 0.08 * (dist - 2.2); // sin(a) = 1 is straight below
    if (mask) { const X = Math.round(x), Y = Math.round(y); if (mask[Y * width + X] < 128) cost *= 1.6; }
    if (!best || cost < best.cost) best = { x, y, cost };
  }
  return best ? [best.x, best.y] : [cx, Math.min(rows - 1, cy + 2.2 * r)];
}
