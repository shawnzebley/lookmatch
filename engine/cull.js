// Culling help, like Narrative Select: eyes open or closed per face, a focus score out of 10 (8+ is
// sharp), and scenes (runs of near-identical frames) so the strongest of each can be picked.
// Pure math on plain arrays; the worker feeds it pixels.

// Focus: how steep the strongest edges are compared with the patch's contrast. Blur spreads every edge,
// so its steepest slope drops while the contrast stays; brightness and contrast cancel out. Measured on
// a crop resampled so it is FOCUS_SIDE px wide (a face at a fixed size, whatever the photo's resolution).
export const FOCUS_SIDE = 192;
function pct(arr, q) { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }
/** gray: Float32Array 0..255. Returns edge steepness (~0.05 blurred .. 0.3+ sharp), or null for a flat patch. */
export function edgeSharpness(gray, w, h) {
  if (w < 8 || h < 8) return null;
  const gm = new Float32Array((w - 2) * (h - 2));
  let k = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
    const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
    gm[k++] = Math.hypot(gx, gy) / 8;
  }
  const C = pct(gray, 0.98) - pct(gray, 0.02);
  if (C < 20) return null;
  return pct(gm, 0.99) / C;
}
export const FOCUS_LO = 0.06, FOCUS_HI = 0.2;
// steepness -> 0..10
export function focusScore(v) {
  if (v == null) return null;
  const t = (v - FOCUS_LO) / (FOCUS_HI - FOCUS_LO);
  return Math.round(100 * Math.min(1, Math.max(0, t))) / 10;
}

// Eyes: MediaPipe blendshapes eyeBlinkLeft/Right (0 open .. 1 closed); closed when both are past 0.5.
export function eyesClosed(blinkL, blinkR) { return blinkL != null && blinkR != null ? Math.min(blinkL, blinkR) > 0.5 : null; }

// ---- scenes --------------------------------------------------------------------------------
// Signature: 12 x 9 grid of mean colour (gamma sRGB 0..1) from a small copy of the photo.
export const SIG_W = 12, SIG_H = 9;
export function sceneSig(rgba, w, h, ch = 4) {
  const sig = new Float32Array(SIG_W * SIG_H * 3), cnt = new Float32Array(SIG_W * SIG_H);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(SIG_H - 1, Math.floor((y * SIG_H) / h));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(SIG_W - 1, Math.floor((x * SIG_W) / w)), k = gy * SIG_W + gx, o = (y * w + x) * ch;
      sig[3 * k] += rgba[o] / 255; sig[3 * k + 1] += rgba[o + 1] / 255; sig[3 * k + 2] += rgba[o + 2] / 255; cnt[k]++;
    }
  }
  for (let k = 0; k < cnt.length; k++) if (cnt[k]) { sig[3 * k] /= cnt[k]; sig[3 * k + 1] /= cnt[k]; sig[3 * k + 2] /= cnt[k]; }
  return Array.from(sig, (v) => Math.round(v * 1000) / 1000);
}
// Distance between signatures after putting both on the same brightness and contrast (an exposure or
// white-balance change between frames of the same setup shouldn't split a scene): each is centred and
// scaled to unit spread, so this is sqrt(2 * (1 - correlation)). 0 = same framing, 0.5+ = different.
function zs(a) {
  let m = 0; for (const v of a) m += v; m /= a.length;
  let q = 0; for (const v of a) q += (v - m) ** 2;
  const sd = Math.sqrt(q / a.length) || 1;
  return a.map((v) => (v - m) / sd);
}
export function sigDist(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  const za = zs(a), zb = zs(b);
  let s = 0;
  for (let i = 0; i < za.length; i++) s += (za[i] - zb[i]) ** 2;
  return Math.sqrt(s / za.length);
}
export const SCENE_SPLIT = 0.8;
/** Scene number per photo, in shooting order: a new scene starts when a frame looks unlike the last one. */
export function groupScenes(sigs, split = SCENE_SPLIT) {
  const out = [];
  let g = 0;
  for (let i = 0; i < sigs.length; i++) {
    if (i > 0 && !(sigDist(sigs[i], sigs[i - 1]) < split)) g++;
    out.push(g);
  }
  return out;
}

/** 0..1 how good a frame is for picking: eyes open matters most, then focus. */
export function keeperScore(c) {
  if (!c) return 0;
  const f = c.focus == null ? 5 : c.focus;
  return (c.eyes === 'closed' ? 0 : 0.5) + 0.05 * f;
}
