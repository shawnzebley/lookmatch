// Edit pipeline. Every slider is a deterministic, global per-pixel operation, so the whole edit
// compiles into one function RGB -> RGB and then into a 3D LUT for full-resolution rendering.
//
// Order: white balance (linear) -> exposure (linear) -> tone (on L*, applied as a luminance ratio)
//        -> HSL mixer -> color grading -> saturation / vibrance (Lab) -> gamut map -> sRGB.

import { SRGB8_TO_LIN, linearToSrgb, srgbToLinear, linToLab, labToLin, yToL, lToY, rgbHue, wheelHueToAB } from './color.js';
import { BANDS, bandWeights, gradeWeights } from './measure.js';

// ---- slider definitions ---------------------------------------------------------------
// cap = the guardrail range the solver may use; ui = the range the user may drag to.
export const SLIDERS = [
  { key: 'temp', label: 'Temp', group: 'White balance', ui: [-100, 100], cap: [-60, 60], lr: 'IncrementalTemperature' },
  { key: 'tint', label: 'Tint', group: 'White balance', ui: [-100, 100], cap: [-50, 50], lr: 'IncrementalTint' },
  { key: 'exposure', label: 'Exposure', group: 'Tone', ui: [-3, 3], cap: [-1.5, 1.5], step: 0.01, lr: 'Exposure2012' },
  { key: 'contrast', label: 'Contrast', group: 'Tone', ui: [-100, 100], cap: [-70, 70], lr: 'Contrast2012' },
  { key: 'highlights', label: 'Highlights', group: 'Tone', ui: [-100, 100], cap: [-100, 70], lr: 'Highlights2012' },
  { key: 'shadows', label: 'Shadows', group: 'Tone', ui: [-100, 100], cap: [-70, 100], lr: 'Shadows2012' },
  { key: 'whites', label: 'Whites', group: 'Tone', ui: [-100, 100], cap: [-100, 60], lr: 'Whites2012' },
  { key: 'blacks', label: 'Blacks', group: 'Tone', ui: [-100, 100], cap: [-60, 80], lr: 'Blacks2012' },
  { key: 'fadeBlacks', label: 'Curve: lift blacks', group: 'Tone curve', ui: [0, 100], cap: [0, 70] },
  { key: 'fadeWhites', label: 'Curve: fade whites', group: 'Tone curve', ui: [0, 100], cap: [0, 70] },
  { key: 'vibrance', label: 'Vibrance', group: 'Presence', ui: [-100, 100], cap: [-60, 60], lr: 'Vibrance' },
  { key: 'saturation', label: 'Saturation', group: 'Presence', ui: [-100, 100], cap: [-50, 40], lr: 'Saturation' },
];
for (const b of BANDS) {
  const B = b[0].toUpperCase() + b.slice(1);
  SLIDERS.push({ key: `hue_${b}`, label: `${B} hue`, group: 'HSL hue', ui: [-100, 100], cap: [-25, 25], lr: `HueAdjustment${B}` });
}
for (const b of BANDS) {
  const B = b[0].toUpperCase() + b.slice(1);
  SLIDERS.push({ key: `sat_${b}`, label: `${B} sat`, group: 'HSL saturation', ui: [-100, 100], cap: [-45, 35], lr: `SaturationAdjustment${B}` });
}
for (const b of BANDS) {
  const B = b[0].toUpperCase() + b.slice(1);
  SLIDERS.push({ key: `lum_${b}`, label: `${B} lum`, group: 'HSL luminance', ui: [-100, 100], cap: [-35, 35], lr: `LuminanceAdjustment${B}` });
}
for (const z of ['shadow', 'midtone', 'highlight']) {
  const Z = z[0].toUpperCase() + z.slice(1);
  SLIDERS.push({ key: `${z}Hue`, label: `${Z}s hue`, group: 'Color grading', ui: [0, 359], cap: [0, 359], hue: true });
  SLIDERS.push({ key: `${z}Sat`, label: `${Z}s sat`, group: 'Color grading', ui: [0, 100], cap: [0, 35] });
}
SLIDERS.push({ key: 'gradeBalance', label: 'Balance', group: 'Color grading', ui: [-100, 100], cap: [-100, 100] });

// skin hues get less push from these (Lightroom's vibrance does the same)
export const SLIDER_BY_KEY = Object.fromEntries(SLIDERS.map((s) => [s.key, s]));

export function defaultParams() {
  const p = {};
  for (const s of SLIDERS) p[s.key] = 0;
  return p;
}

export function clampParams(p, useCap = false) {
  const o = { ...p };
  for (const s of SLIDERS) {
    const [lo, hi] = useCap ? s.cap : s.ui;
    if (s.hue) o[s.key] = ((o[s.key] % 360) + 360) % 360;
    else o[s.key] = Math.min(hi, Math.max(lo, o[s.key] ?? 0));
  }
  return o;
}

// ---- tone ------------------------------------------------------------------------------
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// Basic-panel tone curve on x = L*/100 (after exposure). Returns y in [0,1] (before curve fade).
export function basicTone(x, p) {
  let y = x;
  const c = p.contrast / 100;
  const a = c >= 0 ? c * 0.45 : c * 0.6;
  y += a * (x - 0.5) * 4 * x * (1 - x);
  if (x > 0.5) y += (p.highlights / 100) * 0.14 * Math.sin(Math.PI * (2 * x - 1));
  else y += (p.shadows / 100) * 0.14 * Math.sin(Math.PI * 2 * x);
  y += (p.whites / 100) * 0.12 * smoothstep(0.7, 1, x);
  y += (p.blacks / 100) * 0.1 * (1 - smoothstep(0, 0.3, x));
  return Math.min(1, Math.max(0, y));
}

export function fadeLevels(p) {
  return { lo: (p.fadeBlacks / 100) * 0.25, hi: 1 - (p.fadeWhites / 100) * 0.25 };
}

// Full tone map on L* (0-100) -> L* (0-100)
// exposure with a soft shoulder above 0.9 so pushed highlights compress instead of hard-clipping
export function exposeX(L, p) {
  let x = L / 100;
  if (p.exposure) {
    x = yToL(lToY(L) * Math.pow(2, p.exposure)) / 100;
    if (x > 0.9) x = 0.9 + 0.1 * Math.tanh((x - 0.9) / 0.1);
  }
  return Math.min(1, x);
}
export function toneRaw(L, p) { return 100 * basicTone(exposeX(L, p), p); }
export function toneMapL(L, p, fl = fadeLevels(p)) {
  const y = basicTone(exposeX(L, p), p);
  return 100 * (fl.lo + (fl.hi - fl.lo) * y);
}

// Max slope of the tone map (banding guard), measured in L* units.
export function toneMaxSlope(p) {
  const fl = fadeLevels(p);
  let prev = toneMapL(0, p, fl), mx = 0;
  for (let i = 1; i <= 100; i++) {
    const v = toneMapL(i, p, fl);
    mx = Math.max(mx, v - prev);
    prev = v;
  }
  return mx;
}

// How far the curve runs backwards (brighter input -> darker output), in L* units. 0 = monotonic.
// A reversing curve paints dark halos around bright edges, so the solver forbids it and the app warns.
export function toneReversal(p) {
  const fl = fadeLevels(p);
  let prev = toneMapL(0, p, fl), peak = prev, worst = 0;
  for (let i = 1; i <= 100; i++) {
    const v = toneMapL(i, p, fl);
    peak = Math.max(peak, v);
    worst = Math.max(worst, peak - v);
    prev = v;
  }
  return worst;
}

export { gradeWeights };

// ---- compile params into a per-pixel processor -------------------------------------------
export function compile(p) {
  p = { ...defaultParams(), ...p };
  const T = p.temp / 100, TI = p.tint / 100;
  let gR = Math.exp(0.35 * T), gG = Math.exp(-0.22 * TI), gB = Math.exp(-0.35 * T);
  const norm = 0.2126729 * gR + 0.7151522 * gG + 0.072175 * gB;
  gR /= norm; gG /= norm; gB /= norm;
  const fl = fadeLevels(p);

  // tone LUT on L* in 0.05 steps
  const TN = 2001;
  const toneLut = new Float32Array(TN);
  for (let i = 0; i < TN; i++) toneLut[i] = toneMapL(i * 0.05, p, fl);

  const hueS = BANDS.map((b) => p[`hue_${b}`] / 100 * 30 * Math.PI / 180);
  const satS = BANDS.map((b) => p[`sat_${b}`] / 100);
  const lumS = BANDS.map((b) => p[`lum_${b}`] / 100 * 18);
  const anyHsl = hueS.some((v) => v) || satS.some((v) => v) || lumS.some((v) => v);

  const G = 30; // Lab units at 100% grading saturation
  const zones = p._gradeAB ? p._gradeAB.map(([u, v]) => [u * G / 100, v * G / 100]) : ['shadow', 'midtone', 'highlight'].map((z) => {
    const [da, db] = wheelHueToAB(p[`${z}Hue`]);
    const s = p[`${z}Sat`] / 100 * G;
    return [da * s, db * s];
  });
  const anyGrade = zones.some(([a, b]) => a || b);
  const piv = 0.5 + (p.gradeBalance / 100) * 0.2;

  const sat = 1 + p.saturation / 100;
  const vib = p.vibrance / 100;
  const bw = new Float32Array(8);
  const lab = [0, 0, 0], out = [0, 0, 0];

  // process linear RGB -> writes linear RGB (in gamut) into res[0..2] and Lab into res[3..5]
  return function process(r, g, b, res) {
    r *= gR; g *= gG; b *= gB;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const L0 = yToL(Y);
    let fi = L0 / 0.05; if (fi < 0) fi = 0; if (fi > TN - 1.001) fi = TN - 1.001;
    const i0 = fi | 0, t = fi - i0;
    const L1 = toneLut[i0] + (toneLut[i0 + 1] - toneLut[i0]) * t;
    const Y1 = lToY(L1);
    if (Y > 1e-6) { const k = Y1 / Y; r *= k; g *= k; b *= k; }
    else { r = g = b = Y1; }

    linToLab(r, g, b, lab);
    let L = lab[0], A = lab[1], B = lab[2];
    let C = Math.hypot(A, B);

    if (anyHsl && C > 0.5) {
      const h = rgbHue(linearToSrgb(r), linearToSrgb(g), linearToSrgb(b));
      bandWeights(h, bw);
      // how much a pixel has a real color: near-black and near-grey pixels only have noise for a hue,
      // and pushing them by band would turn sensor noise into blotches
      const col = (C / (C + 8)) * smoothstep(2, 6, C) * smoothstep(3, 12, L);
      let dh = 0, ds = 0, dl = 0;
      for (let k = 0; k < 8; k++) { const w = bw[k]; if (w) { dh += w * hueS[k]; ds += w * satS[k]; dl += w * lumS[k]; } }
      dh *= col;
      if (dh) { const cs = Math.cos(dh), sn = Math.sin(dh); const a2 = A * cs - B * sn; B = A * sn + B * cs; A = a2; }
      const f = Math.max(0, 1 + ds * col);
      A *= f; B *= f;
      L += dl * col;
    }

    if (anyGrade) {
      const [ws, wm, wh] = gradeWeights(L, piv - 0.5);
      const edge = Math.min(1, L / 8) * Math.min(1, (100 - L) / 12);
      A += (ws * zones[0][0] + wm * zones[1][0] + wh * zones[2][0]) * edge;
      B += (ws * zones[0][1] + wm * zones[1][1] + wh * zones[2][1]) * edge;
    }

    if (sat !== 1 || vib) {
      C = Math.hypot(A, B);
      let f = sat;
      if (vib) {
        const h = Math.atan2(B, A) * 57.29578;
        const skinish = 1 - 0.5 * smoothstep(10, 28, h) * (1 - smoothstep(65, 85, h));
        f *= 1 + vib * skinish * Math.max(0, 1 - C / 55);
      }
      f = Math.max(0, f);
      A *= f; B *= f;
    }

    if (L < 0) L = 0;
    labToLin(L, A, B, out);
    // gamut map: keep L* and hue, pull chroma until in range
    if (out[0] < 0 || out[1] < 0 || out[2] < 0 || out[0] > 1 || out[1] > 1 || out[2] > 1) {
      if (L >= 100) { out[0] = out[1] = out[2] = 1; A = B = 0; L = 100; }
      else {
        let lo = 0, hi = 1;
        for (let it = 0; it < 10; it++) {
          const m = (lo + hi) / 2;
          labToLin(L, A * m, B * m, out);
          if (out[0] < 0 || out[1] < 0 || out[2] < 0 || out[0] > 1 || out[1] > 1 || out[2] > 1) hi = m; else lo = m;
        }
        A *= lo; B *= lo;
        labToLin(L, A, B, out);
      }
      out[0] = Math.min(1, Math.max(0, out[0]));
      out[1] = Math.min(1, Math.max(0, out[1]));
      out[2] = Math.min(1, Math.max(0, out[2]));
    }
    res[0] = out[0]; res[1] = out[1]; res[2] = out[2];
    res[3] = L; res[4] = A; res[5] = B;
    return res;
  };
}

// ---- 3D LUT ------------------------------------------------------------------------------
// Grid over gamma-encoded sRGB input; stores gamma-encoded sRGB output as Float32 (r,g,b interleaved),
// index = (ib*N + ig)*N + ir.
export function buildLUT(p, N = 33) {
  const proc = compile(p);
  const lut = new Float32Array(N * N * N * 3);
  const res = new Float64Array(6);
  let o = 0;
  for (let ib = 0; ib < N; ib++) {
    const b = srgbToLinear(ib / (N - 1));
    for (let ig = 0; ig < N; ig++) {
      const g = srgbToLinear(ig / (N - 1));
      for (let ir = 0; ir < N; ir++) {
        proc(srgbToLinear(ir / (N - 1)), g, b, res);
        lut[o++] = linearToSrgb(res[0]);
        lut[o++] = linearToSrgb(res[1]);
        lut[o++] = linearToSrgb(res[2]);
      }
    }
  }
  return { N, data: lut };
}

// Apply a LUT to 8-bit pixels with tetrahedral interpolation and light dithering on output.
// src/dst: Uint8 arrays; chIn/chOut: 3 or 4 channels. Works on any row range (used for tiles).
export function applyLUT(lut, src, dst, count, chIn = 4, chOut = 4, seed = 1) {
  const { N, data } = lut;
  const scale = (N - 1) / 255;
  const idx = new Int32Array(256), frac = new Float32Array(256);
  for (let v = 0; v < 256; v++) { const f = v * scale; let i = Math.floor(f); if (i >= N - 1) i = N - 2; idx[v] = i; frac[v] = f - i; }
  const sR = 3, sG = 3 * N, sB = 3 * N * N;
  let rnd = seed >>> 0 || 1;
  for (let k = 0, si = 0, di = 0; k < count; k++, si += chIn, di += chOut) {
    const r8 = src[si], g8 = src[si + 1], b8 = src[si + 2];
    const ir = idx[r8], ig = idx[g8], ib = idx[b8];
    const fr = frac[r8], fg = frac[g8], fb = frac[b8];
    const base = ib * sB + ig * sG + ir * sR;
    // tetrahedral: choose the simplex by ordering fr, fg, fb
    let o1, o2, w0, w1, w2, w3;
    if (fr >= fg) {
      if (fg >= fb) { o1 = sR; o2 = sR + sG; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb; }
      else if (fr >= fb) { o1 = sR; o2 = sR + sB; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg; }
      else { o1 = sB; o2 = sR + sB; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg; }
    } else {
      if (fb >= fg) { o1 = sB; o2 = sG + sB; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr; }
      else if (fb >= fr) { o1 = sG; o2 = sG + sB; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr; }
      else { o1 = sG; o2 = sR + sG; w0 = 1 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb; }
    }
    const o3 = sR + sG + sB;
    // xorshift dither in [-0.5, 0.5) LSB to break up banding from the 8-bit round trip
    rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
    const d = ((rnd >>> 0) / 4294967296 - 0.5);
    for (let c = 0; c < 3; c++) {
      const v = w0 * data[base + c] + w1 * data[base + o1 + c] + w2 * data[base + o2 + c] + w3 * data[base + o3 + c];
      let q = v * 255 + 0.5 + d * 0.9;
      dst[di + c] = q < 0 ? 0 : q > 255 ? 255 : q | 0;
    }
    if (chOut === 4) dst[di + 3] = chIn === 4 ? src[si + 3] : 255;
  }
}

// Convenience: render an 8-bit image object with params (used by tools and the preview).
export function renderImage(img, p, N = 33) {
  const lut = buildLUT(p, N);
  const ch = img.channels || 4;
  const out = new Uint8Array(img.width * img.height * ch);
  applyLUT(lut, img.data, out, img.width * img.height, ch, ch);
  return { width: img.width, height: img.height, channels: ch, data: out };
}

// Run the exact pipeline on a PixelSet (optionally a subset of indices) for measuring.
export function processPixelSet(ps, p, idx, cur) {
  const proc = compile(p);
  const n = ps.n;
  cur = cur || { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const res = new Float64Array(6);
  const N = idx ? idx.length : n;
  for (let k = 0; k < N; k++) {
    const i = idx ? idx[k] : k;
    proc(ps.lr[i], ps.lg[i], ps.lb[i], res);
    cur.lr[i] = res[0]; cur.lg[i] = res[1]; cur.lb[i] = res[2];
    cur.L[i] = res[3]; cur.A[i] = res[4]; cur.B[i] = res[5];
  }
  return cur;
}
