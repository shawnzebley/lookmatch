// Effects that need neighbouring pixels or a mask, so they can't live in the LUT. They run on 8-bit
// RGBA already through the LUT, like the skin pass, on whole images or on export bands with context
// rows above and below (core0..core1 are the rows written). Radii scale with the output's long side.
//
//   texture   fine detail (Lightroom Texture): luminance minus a small blur
//   clarity   mid-tone local contrast (Lightroom Clarity): luminance minus a wide blur, weighted to mids
//   sharpness unsharp mask at the texture radius; negative softens
//   dehaze    dark-channel haze estimate (He et al. 2009) with a box-mean in place of the min filter and
//             a fixed atmospheric colour measured per photo; positive removes haze, negative adds it
//   lookMasks local adjustments from a dynamic look: Light/Color sliders through their own LUT, mixed
//             in by the mask, then the detail effects above weighted by the mask
// Approach follows LightCraft's Effects panel (ArtCraft, MIT OR Apache-2.0); the code is our own.

import { LOCAL_SLIDERS, buildLUT, applyLUT, withLocal } from './pipeline.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DETAIL_KEYS = ['texture', 'clarity', 'dehaze', 'sharpness'];
const TONE_KEYS = new Set(LOCAL_SLIDERS.map((s) => s.key));

export function detailRadii(long) {
  return { tex: Math.max(1, Math.round(long * 0.0022)), cla: Math.max(2, Math.round(long * 0.011)), haze: Math.max(3, Math.round(long * 0.015)) };
}
/** Rows of context a band needs so it matches the whole-image result. */
export function effectsHalo(long) { const r = detailRadii(long); return 2 * Math.max(r.cla, r.haze) + 2; }

const anyDetail = (k) => DETAIL_KEYS.some((key) => k && k[key]);
export function hasLookEffects(p) {
  return !!(p && (anyDetail(p) || (p.lookMasks && p.lookMasks.some((m) => m.adj && Object.values(m.adj).some(Boolean)))));
}

function boxMean(src, w, h, r, out = new Float32Array(w * h), tmp = new Float32Array(w * h)) {
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
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
const blur2 = (src, w, h, r) => { const t = new Float32Array(w * h); return boxMean(boxMean(src, w, h, r, undefined, t), w, h, r, undefined, t); };

/** Atmospheric light for dehaze: mean colour (0..1) of the haziest 0.5% (highest dark channel). */
export function hazeColor(rgba, n, ch = 4) {
  const dark = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += ch) { const v = Math.min(rgba[j], rgba[j + 1], rgba[j + 2]); dark[i] = v; hist[v]++; }
  let need = Math.max(1, Math.round(n * 0.005)), t = 255;
  for (; t > 0 && need > 0; t--) need -= hist[t];
  let r = 0, g = 0, b = 0, c = 0;
  for (let i = 0, j = 0; i < n; i++, j += ch) if (dark[i] > t) { r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++; }
  if (!c) return [0.9, 0.9, 0.9];
  return [r / c / 255, g / c / 255, b / c / 255].map((v) => clamp(v, 0.6, 1));
}

/**
 * Texture / clarity / sharpness / dehaze on buf (8-bit RGBA band). k: { texture, clarity, sharpness,
 * dehaze } in -100..100. weight: optional 0..255 plane the size of the band (null = everywhere).
 */
export function applyDetail(buf, width, rows, k, weight, long, hazeA = [0.9, 0.9, 0.9], ch = 4, core0 = 0, core1 = rows) {
  if (!anyDetail(k)) return;
  const kT = clamp((k.texture || 0) / 100, -1, 1), kC = 0.7 * clamp((k.clarity || 0) / 100, -1, 1);
  const kS = clamp((k.sharpness || 0) / 100, -1, 1), kD = clamp((k.dehaze || 0) / 100, -1, 1);
  const R = detailRadii(long), n = width * rows;
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += ch) Y[i] = (0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2]) / 255;
  const bT = kT || kS ? blur2(Y, width, rows, R.tex) : null;
  const bC = kC ? blur2(Y, width, rows, R.cla) : null;
  let dark = null;
  if (kD) {
    dark = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += ch) dark[i] = Math.min(buf[j] / hazeA[0], buf[j + 1] / hazeA[1], buf[j + 2] / hazeA[2]) / 255;
    dark = blur2(dark, width, rows, R.haze);
  }
  const A = hazeA.map((v) => v * 255);
  for (let y = core0; y < core1; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const wgt = weight ? weight[i] / 255 : 1;
      if (wgt <= 0.004) continue;
      const o = i * ch, v = Y[i];
      let r = buf[o], g = buf[o + 1], b = buf[o + 2];
      if (dark) {
        // transmission t = 1 - 0.95 * dark; recover (I - A) / t + A, mixed in by the amount
        const t = Math.max(0.3, 1 - 0.95 * dark[i]);
        const m = kD * wgt;
        if (m > 0) { r += ((r - A[0]) / t + A[0] - r) * m * 0.9; g += ((g - A[1]) / t + A[1] - g) * m * 0.9; b += ((b - A[2]) / t + A[2] - b) * m * 0.9; }
        else { const f = -m * 0.5 * (0.5 + 0.5 * dark[i]); r += (A[0] - r) * f; g += (A[1] - g) * f; b += (A[2] - b) * f; }
      }
      let d = 0;
      if (bT) d += (kT + (kS > 0 ? 1.5 * kS : kS)) * (v - bT[i]);
      if (bC) d += kC * 4 * v * (1 - v) * (v - bC[i]);
      d *= 255 * wgt;
      r += d; g += d; b += d;
      buf[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
      buf[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5;
      buf[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5;
    }
  }
}

// the Light/Color part of a mask's adjustments as its own LUT; a few recent ones are kept
const lutCache = new Map();
function maskLUT(base, adj) {
  const tone = {};
  for (const [key, v] of Object.entries(adj)) if (TONE_KEYS.has(key) && v) tone[key] = v;
  if (!Object.keys(tone).length) return null;
  const { lookMasks, local, ...rest } = base;
  const id = JSON.stringify([rest, tone]);
  let lut = lutCache.get(id);
  if (!lut) {
    lut = buildLUT(withLocal(rest, tone), 33);
    lutCache.set(id, lut);
    if (lutCache.size > 24) lutCache.delete(lutCache.keys().next().value);
  }
  return lut;
}

/**
 * Global detail effects, then each look mask. out: the band through the main LUT; src: the same rows
 * before it (for the masks' own LUTs). planes[i]: mask i at band size (0..255) or null when it could
 * not be placed on this photo (that mask is skipped).
 */
export function applyLookEffects(out, src, width, rows, p, { long, planes = [], hazeA, core0 = 0, core1 = rows, ch = 4, seed = 1 } = {}) {
  if (!hasLookEffects(p)) return;
  const n = width * rows;
  const masks = p.lookMasks || [];
  for (let m = 0; m < masks.length; m++) {
    const plane = planes[m];
    if (!plane || !masks[m].adj) continue;
    const lut = maskLUT(p, masks[m].adj);
    if (!lut) continue;
    const tmp = new Uint8ClampedArray(n * ch);
    applyLUT(lut, src, tmp, n, ch, ch, seed);
    for (let i = 0, j = 0; i < n; i++, j += ch) {
      const w = plane[i];
      if (!w) continue;
      const t = w / 255;
      out[j] += (tmp[j] - out[j]) * t; out[j + 1] += (tmp[j + 1] - out[j + 1]) * t; out[j + 2] += (tmp[j + 2] - out[j + 2]) * t;
    }
  }
  applyDetail(out, width, rows, p, null, long, hazeA, ch, core0, core1);
  for (let m = 0; m < masks.length; m++) if (planes[m] && anyDetail(masks[m].adj)) applyDetail(out, width, rows, masks[m].adj, planes[m], long, hazeA, ch, core0, core1);
}
