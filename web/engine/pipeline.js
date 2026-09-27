// Edit pipeline. Every slider is a deterministic, global per-pixel operation, so the whole edit
// compiles into one function RGB -> RGB and then into a 3D LUT for full-resolution rendering.
//
// Order: calibration (linear 3x3 + shadow tint) -> white balance (linear) -> exposure (linear)
//        -> tone (on L*, applied as a luminance ratio) -> point curve + R/G/B curves (gamma sRGB, like Lightroom)
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
for (const c of ['Red', 'Green', 'Blue']) {
  SLIDERS.push({ key: `cal${c}Hue`, label: `${c} primary hue`, group: 'Calibration', ui: [-100, 100], cap: [0, 0], lr: `${c}Hue` });
  SLIDERS.push({ key: `cal${c}Sat`, label: `${c} primary sat`, group: 'Calibration', ui: [-100, 100], cap: [0, 0], lr: `${c}Saturation` });
}
SLIDERS.push({ key: 'calShadowTint', label: 'Shadow tint', group: 'Calibration', ui: [-100, 100], cap: [0, 0], lr: 'ShadowTint' });
// Finish: what a preset leaves to the phone pass (Snapseed/Mextures-style). Blacks and roll-off are
// global and live in the LUT; vignette and grain depend on pixel position and run after it (applyFinish).
SLIDERS.push({ key: 'finishBlacks', label: 'Deepen blacks', group: 'Finish', ui: [0, 100], cap: [0, 100] });
SLIDERS.push({ key: 'finishRolloff', label: 'Roll off highlights', group: 'Finish', ui: [0, 100], cap: [0, 100] });
// (finishShA/B, finishHiA/B Lab tints are still honoured by compile() but the photographer fit now uses the colour wheels)
SLIDERS.push({ key: 'finishSat', label: 'Color intensity', group: 'Finish', ui: [-60, 60], cap: [-60, 60] });
SLIDERS.push({ key: 'vignette', label: 'Vignette', group: 'Finish', ui: [-100, 100], cap: [-100, 100], lr: 'PostCropVignetteAmount' });
SLIDERS.push({ key: 'grain', label: 'Grain', group: 'Finish', ui: [0, 100], cap: [0, 100], lr: 'GrainAmount' });
SLIDERS.push({ key: 'grainSize', label: 'Grain size', group: 'Finish', ui: [0, 100], cap: [0, 100], lr: 'GrainSize' });
SLIDERS.push({ key: 'gradeBalance', label: 'Balance', group: 'Color grading', ui: [-100, 100], cap: [-100, 100] });

// skin hues get less push from these (Lightroom's vibrance does the same)
export const SLIDER_BY_KEY = Object.fromEntries(SLIDERS.map((s) => [s.key, s]));

// ---- subject / background ----------------------------------------------------------------
// params.local = { subject: {...}, background: {...} }: amounts added on top of the whole-photo
// sliders inside each region (like a Lightroom mask's local sliders). The colour wheels add in Lab.
export const REGIONS = ['subject', 'background'];
export const LOCAL_SLIDERS = [
  { key: 'exposure', label: 'Exposure', group: 'Light', ui: [-2, 2], step: 0.01 },
  { key: 'contrast', label: 'Contrast', group: 'Light', ui: [-100, 100] },
  { key: 'highlights', label: 'Highlights', group: 'Light', ui: [-100, 100] },
  { key: 'shadows', label: 'Shadows', group: 'Light', ui: [-100, 100] },
  { key: 'whites', label: 'Whites', group: 'Light', ui: [-100, 100] },
  { key: 'blacks', label: 'Blacks', group: 'Light', ui: [-100, 100] },
  { key: 'temp', label: 'Temp', group: 'Color', ui: [-100, 100] },
  { key: 'tint', label: 'Tint', group: 'Color', ui: [-100, 100] },
  { key: 'saturation', label: 'Saturation', group: 'Color', ui: [-100, 100] },
  { key: 'vibrance', label: 'Vibrance', group: 'Color', ui: [-100, 100] },
];
export const LOCAL_WHEEL_KEYS = ['shadowHue', 'shadowSat', 'midtoneHue', 'midtoneSat', 'highlightHue', 'highlightSat'];
const ZONES3 = ['shadow', 'midtone', 'highlight'];

function wheelAB(hue, sat) {
  if (!sat) return [0, 0];
  const [a, b] = wheelHueToAB(hue || 0);
  return [a * sat, b * sat];
}

/** Does this region carry any change? */
export function localActive(loc) {
  if (!loc) return false;
  for (const s of LOCAL_SLIDERS) if (loc[s.key]) return true;
  return ZONES3.some((z) => loc[`${z}Sat`]);
}
/** Does the edit treat subject and background differently? */
export function hasLocal(p) { return !!(p && p.local && (localActive(p.local.subject) || localActive(p.local.background))); }

/** Whole-photo params with one region's local amounts added. */
export function withLocal(p, loc) {
  if (!localActive(loc)) return p;
  const q = { ...p };
  delete q.local;
  for (const s of LOCAL_SLIDERS) {
    const d = loc[s.key];
    if (!d) continue;
    const g = SLIDER_BY_KEY[s.key];
    q[s.key] = Math.min(g.ui[1], Math.max(g.ui[0], (p[s.key] || 0) + d));
  }
  if (ZONES3.some((z) => loc[`${z}Sat`])) {
    q._gradeAB = ZONES3.map((z, i) => {
      const [a, b] = p._gradeAB ? p._gradeAB[i] : wheelAB(p[`${z}Hue`], p[`${z}Sat`]);
      const [c, d] = wheelAB(loc[`${z}Hue`], loc[`${z}Sat`]);
      return [a + c, b + d];
    });
  }
  return q;
}
export function regionParams(p) {
  return { subject: withLocal(p, p.local && p.local.subject), background: withLocal(p, p.local && p.local.background) };
}

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

// ---- point curves ---------------------------------------------------------------------------
// Curves are arrays of [x, y] in 0-255 (Lightroom's ToneCurvePV2012*). Params keys: curve, curveR, curveG, curveB.
export const CURVE_KEYS = ['curve', 'curveR', 'curveG', 'curveB'];
export function isIdentityCurve(pts) { return !pts || pts.length < 2 || pts.every(([x, y]) => x === y); }

// Monotone cubic (Fritsch-Carlson) through the points; Lightroom's curve is a smooth spline that
// doesn't overshoot between points, which this matches closely. Returns a 1024-entry LUT on [0,1].
export function curveLUT(pts, N = 1024) {
  const P = pts.slice().sort((a, b) => a[0] - b[0]).filter((q, i, a) => !i || q[0] > a[i - 1][0]).map(([x, y]) => [x / 255, y / 255]);
  const lut = new Float32Array(N);
  if (P.length < 2) { for (let i = 0; i < N; i++) lut[i] = i / (N - 1); return lut; }
  const n = P.length, d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], t = a * a + b * b;
    if (t > 9) { const k = 3 / Math.sqrt(t); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  let seg = 0;
  for (let j = 0; j < N; j++) {
    const x = j / (N - 1);
    if (x <= P[0][0]) { lut[j] = P[0][1]; continue; }
    if (x >= P[n - 1][0]) { lut[j] = P[n - 1][1]; continue; }
    while (x > P[seg + 1][0]) seg++;
    const h = P[seg + 1][0] - P[seg][0], t = (x - P[seg][0]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * P[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * P[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
    lut[j] = Math.min(1, Math.max(0, y));
  }
  return lut;
}
function lookup(lut, v) {
  let f = v * 1023; if (f <= 0) return lut[0]; if (f >= 1023) return lut[1023];
  const i = f | 0; return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}

// ---- calibration --------------------------------------------------------------------------------
// Approximates Lightroom's Calibration panel as a 3x3 matrix on linear RGB: each primary's hue slider
// swings it toward its neighbour (red + -> yellow, green + -> cyan, blue + -> magenta), its saturation
// slider pushes it away from / toward grey. Rows are normalised so white stays white.
export function calibrationMatrix(p) {
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const plus = [1, 2, 0], minus = [2, 0, 1]; // neighbour channel added for + / - hue
  const names = ['Red', 'Green', 'Blue'];
  let any = false;
  for (let i = 0; i < 3; i++) {
    const hh = (p[`cal${names[i]}Hue`] || 0) / 100, ss = (p[`cal${names[i]}Sat`] || 0) / 100;
    if (!hh && !ss) continue;
    any = true;
    const c = cols[i];
    if (hh > 0) c[plus[i]] += 0.35 * hh; else if (hh < 0) c[minus[i]] += -0.35 * hh;
    const m = (c[0] + c[1] + c[2]) / 3, k = 1 + 0.45 * ss;
    for (let j = 0; j < 3; j++) c[j] = m + (c[j] - m) * k;
  }
  if (!any) return null;
  const M = [0, 1, 2].map((r) => [cols[0][r], cols[1][r], cols[2][r]]);
  for (const row of M) { const s = row[0] + row[1] + row[2]; for (let j = 0; j < 3; j++) row[j] /= s; }
  return M;
}

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

  const cal = calibrationMatrix(p);
  const shTint = (p.calShadowTint || 0) / 100;
  const cM = !isIdentityCurve(p.curve) ? curveLUT(p.curve) : null;
  const cR = !isIdentityCurve(p.curveR) ? curveLUT(p.curveR) : null;
  const cG = !isIdentityCurve(p.curveG) ? curveLUT(p.curveG) : null;
  const cB = !isIdentityCurve(p.curveB) ? curveLUT(p.curveB) : null;
  const anyCurve = cM || cR || cG || cB;

  const G = 30; // Lab units at 100% grading saturation
  const zones = p._gradeAB ? p._gradeAB.map(([u, v]) => [u * G / 100, v * G / 100]) : ['shadow', 'midtone', 'highlight'].map((z) => {
    const [da, db] = wheelHueToAB(p[`${z}Hue`]);
    const s = p[`${z}Sat`] / 100 * G;
    return [da * s, db * s];
  });
  const anyGrade = zones.some(([a, b]) => a || b);
  const piv = 0.5 + (p.gradeBalance / 100) * 0.2;

  // finish: black crush (up to 30 L* at the bottom, fading out through the mids) and a highlight shoulder
  // that caps output white at 100 - 0.2*rolloff with a soft 18 L* knee. Both are monotonic.
  const fB = (p.finishBlacks || 0) / 100 * 30;
  const top = 100 - (p.finishRolloff || 0) * 0.2, knee = top - 18;
  const finishL = (L) => {
    if (fB) { const x = Math.max(0, 1 - L / 100); L = Math.max(0, L - fB * x * x * x); }
    if (top < 100 && L > knee) L = knee + (top - knee) * Math.tanh((L - knee) / (top - knee));
    return L;
  };
  const anyFinishL = fB > 0 || top < 100;
  const fSh = [p.finishShA || 0, p.finishShB || 0], fHi = [p.finishHiA || 0, p.finishHiB || 0];
  const anyFinishTint = fSh[0] || fSh[1] || fHi[0] || fHi[1];
  const fSat = 1 + (p.finishSat || 0) / 100;

  const sat = 1 + p.saturation / 100;
  const vib = p.vibrance / 100;
  const bw = new Float32Array(8);
  const lab = [0, 0, 0], out = [0, 0, 0];

  // process linear RGB -> writes linear RGB (in gamut) into res[0..2] and Lab into res[3..5]
  return function process(r, g, b, res) {
    if (cal) {
      const r2 = cal[0][0] * r + cal[0][1] * g + cal[0][2] * b;
      const g2 = cal[1][0] * r + cal[1][1] * g + cal[1][2] * b;
      const b2 = cal[2][0] * r + cal[2][1] * g + cal[2][2] * b;
      r = Math.max(0, r2); g = Math.max(0, g2); b = Math.max(0, b2);
    }
    if (shTint) {
      // + is magenta (less green) in the shadows, fading out by the midtones
      const Ys = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
      const w = 1 - smoothstep(0, 0.45, Math.sqrt(Ys));
      g *= Math.exp(-0.25 * shTint * w);
    }
    r *= gR; g *= gG; b *= gB;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const L0 = yToL(Y);
    let fi = L0 / 0.05; if (fi < 0) fi = 0; if (fi > TN - 1.001) fi = TN - 1.001;
    const i0 = fi | 0, t = fi - i0;
    const L1 = toneLut[i0] + (toneLut[i0 + 1] - toneLut[i0]) * t;
    const Y1 = lToY(L1);
    if (Y > 1e-6) { const k = Y1 / Y; r *= k; g *= k; b *= k; }
    else { r = g = b = Y1; }

    if (anyCurve) {
      let sr = linearToSrgb(Math.min(1, r)), sg = linearToSrgb(Math.min(1, g)), sb = linearToSrgb(Math.min(1, b));
      if (cM) { sr = lookup(cM, sr); sg = lookup(cM, sg); sb = lookup(cM, sb); }
      if (cR) sr = lookup(cR, sr);
      if (cG) sg = lookup(cG, sg);
      if (cB) sb = lookup(cB, sb);
      r = srgbToLinear(sr); g = srgbToLinear(sg); b = srgbToLinear(sb);
    }

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

    if (anyFinishTint) {
      // Lab offsets in L* bands that match how the profiles were measured (shadows < 30, highlights >= 70)
      const ws = 1 - smoothstep(20, 40, L), wh = smoothstep(60, 80, L);
      const edge = Math.min(1, L / 6) * Math.min(1, (100 - L) / 6);
      A += (ws * fSh[0] + wh * fHi[0]) * edge;
      B += (ws * fSh[1] + wh * fHi[1]) * edge;
    }
    if (fSat !== 1) { const f = Math.max(0, fSat); A *= f; B *= f; }
    if (anyFinishL) {
      const L2 = finishL(L);
      if (L > 0.5) { const k = L2 / L; A *= Math.min(1, 0.5 + 0.5 * k); B *= Math.min(1, 0.5 + 0.5 * k); }
      L = L2;
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

/**
 * Two LUTs mixed per pixel by mask (0..255 = background..subject). Pixels fully inside one region
 * only look up that region's LUT, so the cost is close to a single LUT away from the mask edge.
 */
export function applyLUTMasked(lutS, lutB, mask, src, dst, count, chIn = 4, chOut = 4, seed = 1) {
  const N = lutS.N, dS = lutS.data, dB = lutB.data;
  const scale = (N - 1) / 255;
  const idx = new Int32Array(256), frac = new Float32Array(256);
  for (let v = 0; v < 256; v++) { const f = v * scale; let i = Math.floor(f); if (i >= N - 1) i = N - 2; idx[v] = i; frac[v] = f - i; }
  const sR = 3, sG = 3 * N, sB = 3 * N * N, o3 = sR + sG + sB;
  let rnd = seed >>> 0 || 1;
  const vs = [0, 0, 0], vb = [0, 0, 0];
  for (let k = 0, si = 0, di = 0; k < count; k++, si += chIn, di += chOut) {
    const r8 = src[si], g8 = src[si + 1], b8 = src[si + 2];
    const fr = frac[r8], fg = frac[g8], fb = frac[b8];
    const base = idx[b8] * sB + idx[g8] * sG + idx[r8] * sR;
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
    const m = mask[k];
    if (m > 0) for (let c = 0; c < 3; c++) vs[c] = w0 * dS[base + c] + w1 * dS[base + o1 + c] + w2 * dS[base + o2 + c] + w3 * dS[base + o3 + c];
    if (m < 255) for (let c = 0; c < 3; c++) vb[c] = w0 * dB[base + c] + w1 * dB[base + o1 + c] + w2 * dB[base + o2 + c] + w3 * dB[base + o3 + c];
    const t = m / 255;
    rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
    const d = ((rnd >>> 0) / 4294967296 - 0.5);
    for (let c = 0; c < 3; c++) {
      const v = m === 255 ? vs[c] : m === 0 ? vb[c] : vb[c] + (vs[c] - vb[c]) * t;
      const q = v * 255 + 0.5 + d * 0.9;
      dst[di + c] = q < 0 ? 0 : q > 255 ? 255 : q | 0;
    }
    if (chOut === 4) dst[di + 3] = chIn === 4 ? src[si + 3] : 255;
  }
}

/** One LUT, or two (subject, background) when the edit has local amounts and there is a mask. */
export function buildLUTs(p, N = 33) {
  if (!hasLocal(p)) return { lut: buildLUT(p, N) };
  const r = regionParams(p);
  return { subject: buildLUT(r.subject, N), background: buildLUT(r.background, N) };
}
export function applyLUTs(luts, mask, src, dst, count, chIn = 4, chOut = 4, seed = 1) {
  if (luts.lut) return applyLUT(luts.lut, src, dst, count, chIn, chOut, seed);
  if (!mask) return applyLUT(luts.background, src, dst, count, chIn, chOut, seed);
  return applyLUTMasked(luts.subject, luts.background, mask, src, dst, count, chIn, chOut, seed);
}

// ---- finish pass (position-dependent) -------------------------------------------------------
export function hasSpatialFinish(p) { return !!(p.vignette || p.grain); }

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) S2L[i] = srgbToLinear(i / 255);
function hash2(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5; }

/**
 * Vignette + grain on 8-bit RGBA rows already through the LUT. Works on a band of rows of a larger
 * image: (y0, fullW, fullH) place the band so tiles and the preview agree. Grain cell size scales
 * with the full width, so a 1400 px preview and the 24 MP export look the same.
 * vignette: -100 darkens edges (Lightroom post-crop style, highlight-protecting), +100 lightens.
 * grain: 0-100 amount, grainSize 0-100.
 */
export function applyFinish(buf, width, rows, p, y0 = 0, fullW = width, fullH = rows, seed = 7, ch = 4) {
  const vig = (p.vignette || 0) / 100, gAmt = (p.grain || 0) / 100;
  if (!vig && !gAmt) return;
  const cx = fullW / 2, cy = fullH / 2, rx = fullW / 2, ry = fullH / 2;
  const cell = Math.max(1, fullW / 1400 * (1 + (p.grainSize || 0) / 25)); // px per grain cell at this resolution
  const amp = gAmt * 0.09;
  for (let y = 0; y < rows; y++) {
    const Y = y + y0, dy = (Y + 0.5 - cy) / ry;
    const gy = Y / cell, iy = Math.floor(gy), fy = gy - iy, sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      let r = S2L[buf[o]], g = S2L[buf[o + 1]], b = S2L[buf[o + 2]];
      if (vig) {
        const dx = (x + 0.5 - cx) / rx;
        const d = Math.sqrt((dx * dx + dy * dy) / 2);          // 0 center, 1 corner
        const t = smoothstep(0.35, 1.05, d); const w = t * t;
        if (vig < 0) {
          // darken, protecting what's already bright (LR's highlight priority)
          const Yl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const k = 1 + vig * 0.85 * w * (1 - 0.6 * smoothstep(0.5, 1, Yl));
          r *= k; g *= k; b *= k;
        } else { const k = vig * 0.7 * w; r += (1 - r) * k; g += (1 - g) * k; b += (1 - b) * k; }
      }
      let sr = linearToSrgb(r), sg = linearToSrgb(g), sb = linearToSrgb(b);
      if (amp) {
        const gx = x / cell, ix = Math.floor(gx), fx = gx - ix, sx = fx * fx * (3 - 2 * fx);
        const n00 = hash2(ix, iy, seed), n10 = hash2(ix + 1, iy, seed), n01 = hash2(ix, iy + 1, seed), n11 = hash2(ix + 1, iy + 1, seed);
        const n = (n00 + (n10 - n00) * sx) + ((n01 + (n11 - n01) * sx) - (n00 + (n10 - n00) * sx)) * sy;
        const l = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
        const dn = n * 2 * amp * (0.35 + 2.6 * l * (1 - l)); // most in the mids, like film
        sr += dn; sg += dn; sb += dn;
      }
      buf[o] = sr <= 0 ? 0 : sr >= 1 ? 255 : sr * 255 + 0.5 | 0;
      buf[o + 1] = sg <= 0 ? 0 : sg >= 1 ? 255 : sg * 255 + 0.5 | 0;
      buf[o + 2] = sb <= 0 ? 0 : sb >= 1 ? 255 : sb * 255 + 0.5 | 0;
    }
  }
}

// Convenience: render an 8-bit image object with params (used by tools and the preview).
// mask: optional Uint8Array (0..255 subject) the size of img, used when params have local amounts
export function renderImage(img, p, N = 33, mask = null) {
  const luts = buildLUTs(p, N);
  const ch = img.channels || 4;
  const out = new Uint8Array(img.width * img.height * ch);
  applyLUTs(luts, mask, img.data, out, img.width * img.height, ch, ch);
  if (hasSpatialFinish(p)) applyFinish(out, img.width, img.height, p, 0, img.width, img.height, 7, ch);
  return { width: img.width, height: img.height, channels: ch, data: out };
}

// Run the exact pipeline on a PixelSet (optionally a subset of indices) for measuring.
// With local amounts and a subject mask (ps.subject), each pixel is a mix of the two regions' results.
export function processPixelSet(ps, p, idx, cur) {
  const n = ps.n;
  cur = cur || { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const res = new Float64Array(6);
  const N = idx ? idx.length : n;
  const mask = ps.subject;
  if (!mask || !hasLocal(p)) {
    const proc = compile(hasLocal(p) ? withLocal(p, p.local.background) : p);
    for (let k = 0; k < N; k++) {
      const i = idx ? idx[k] : k;
      proc(ps.lr[i], ps.lg[i], ps.lb[i], res);
      cur.lr[i] = res[0]; cur.lg[i] = res[1]; cur.lb[i] = res[2];
      cur.L[i] = res[3]; cur.A[i] = res[4]; cur.B[i] = res[5];
    }
    return cur;
  }
  const rp = regionParams(p);
  const pS = compile(rp.subject), pB = compile(rp.background);
  const r2 = new Float64Array(6), lab = [0, 0, 0];
  for (let k = 0; k < N; k++) {
    const i = idx ? idx[k] : k;
    const m = mask[i];
    if (m >= 255) pS(ps.lr[i], ps.lg[i], ps.lb[i], res);
    else if (m <= 0) pB(ps.lr[i], ps.lg[i], ps.lb[i], res);
    else {
      pS(ps.lr[i], ps.lg[i], ps.lb[i], res);
      pB(ps.lr[i], ps.lg[i], ps.lb[i], r2);
      const t = m / 255;
      res[0] = r2[0] + (res[0] - r2[0]) * t; res[1] = r2[1] + (res[1] - r2[1]) * t; res[2] = r2[2] + (res[2] - r2[2]) * t;
      linToLab(res[0], res[1], res[2], lab);
      res[3] = lab[0]; res[4] = lab[1]; res[5] = lab[2];
    }
    cur.lr[i] = res[0]; cur.lg[i] = res[1]; cur.lb[i] = res[2];
    cur.L[i] = res[3]; cur.A[i] = res[4]; cur.B[i] = res[5];
  }
  return cur;
}
