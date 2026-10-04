// Solver: finds slider values that bring THIS photo's measurements to the preset's targets.
// Staged bounded Levenberg-Marquardt: tone -> white balance -> color -> tone/WB touch-up.

import { PCTS, BANDS, measure } from './measure.js';
import { SLIDER_BY_KEY, defaultParams, toneMapL, exposeX, fadeLevels, curveLUT, isIdentityCurve, processPixelSet, clampParams } from './pipeline.js';
import { wheelHueToAB, abToWheelHue, wrapDeg, linearToSrgb, lToY } from './color.js';

// ---------------- generic bounded LM (projected), finite-difference Jacobian --------------------
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

export function lm(fn, x0, lo, hi, { iters = 25, h = null, lambda0 = 1e-2 } = {}) {
  const k = x0.length;
  let x = x0.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
  let r = fn(x);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = lambda0;
  const hs = h || lo.map((l, i) => (hi[i] - l) * 0.005 + 1e-4);
  let evals = 1;
  for (let it = 0; it < iters; it++) {
    const m = r.length;
    const J = Array.from({ length: m }, () => new Float64Array(k));
    for (let j = 0; j < k; j++) {
      const xp = x.slice();
      let step = hs[j];
      if (xp[j] + step > hi[j]) step = -step;
      xp[j] += step;
      const rp = fn(xp); evals++;
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r[i]) / step;
    }
    const JtJ = Array.from({ length: k }, () => new Float64Array(k));
    const Jtr = new Float64Array(k);
    for (let i = 0; i < m; i++) {
      const Ji = J[i], ri = r[i];
      for (let a = 0; a < k; a++) {
        const va = Ji[a];
        if (!va) continue;
        Jtr[a] += va * ri;
        for (let b = a; b < k; b++) JtJ[a][b] += va * Ji[b];
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];
    let improved = false;
    for (let tries = 0; tries < 6; tries++) {
      const A = JtJ.map((row, a) => { const rr = Array.from(row); rr[a] += lambda * (row[a] + 1e-6); return rr; });
      const d = solveLinear(A, Array.from(Jtr, (v) => -v));
      const xn = x.map((v, i) => Math.min(hi[i], Math.max(lo[i], v + d[i])));
      const rn = fn(xn); evals++;
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        const rel = (cost - cn) / (cost + 1e-12);
        x = xn; r = rn; cost = cn; lambda = Math.max(1e-7, lambda / 3); improved = true;
        if (rel < 1e-4) it = iters;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { x, cost, evals };
}

// ---------------- targets ----------------------------------------------------------------------
export function computeTargets(o, ref, { strength = 1, adaptive = false } = {}) {
  const s = Math.min(1, Math.max(0, strength));
  const anchor = o.tone.pct[50] + s * (ref.tone.pct[50] - o.tone.pct[50]);
  const pct = Object.fromEntries(PCTS.map((p) => [p, o.tone.pct[p] + s * (ref.tone.pct[p] - o.tone.pct[p])]));
  const hasNeutralReference = (o.wb.pixels || 0) >= 0.02 && (ref.wb.pixels || 0) >= 0.02;
  const wbConf = adaptive && !hasNeutralReference ? 0 : Math.min(1, o.wb.confidence / 0.4) * Math.min(1, ref.wb.confidence / 0.4);
  const sw = s * wbConf;
  const wb = { a: o.wb.a + sw * (ref.wb.a - o.wb.a), b: o.wb.b + sw * (ref.wb.b - o.wb.b), weight: 0.3 + 0.7 * wbConf };
  const zones = {};
  for (const z of adaptive ? [] : ['shadows', 'midtones', 'highlights']) {
    const mass = Math.min(o.zones[z].mass, ref.zones[z].mass);
    if (mass < 0.02) continue;
    const zs = s;
    zones[z] = { a: o.zones[z].a + zs * (ref.zones[z].a - o.zones[z].a), b: o.zones[z].b + zs * (ref.zones[z].b - o.zones[z].b), weight: Math.sqrt(Math.min(1, mass / 0.1)) };
  }
  const bands = {};
  const sourceBands = adaptive ? (o.bandsAdaptive || o.bandsBg || o.bands) : o.bands;
  const referenceBands = adaptive ? (ref.bandsAdaptive || ref.bandsBg || ref.bands) : ref.bands;
  for (const b of BANDS) {
    const ob = sourceBands[b], rb = referenceBands[b];
    if (ob.weight < (adaptive ? 0.015 : 0.008) || rb.weight < (adaptive ? 0.015 : 0.008)) continue;
    const dh = wrapDeg(rb.hue - ob.hue);
    bands[b] = {
      hue: wrapDeg(ob.hue + s * dh),
      chroma: ob.chroma + s * (rb.chroma - ob.chroma),
      lumRel: ob.lumRel + s * (rb.lumRel - ob.lumRel),
      weight: Math.sqrt(Math.min(1, Math.min(ob.weight, rb.weight) / 0.05)),
    };
  }
  const color = adaptive ? null : {
    meanChroma: o.color.meanChroma + s * (ref.color.meanChroma - o.color.meanChroma),
    lowChroma: o.color.lowChroma + s * (ref.color.lowChroma - o.color.lowChroma),
  };
  const clip = {
    hi: Math.max(o.tone.clipHi, ref.tone.clipHi) + 0.001,
    lo: Math.max(o.tone.clipLo, ref.tone.clipLo) + 0.001,
  };
  return { tone: { pct }, wb, zones, bands, color, clip, strength: s, anchor, adaptive };
}

// ---------------- stage residuals ------------------------------------------------------------------
const TONE_KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'fadeBlacks', 'fadeWhites'];
const WB_KEYS = ['temp', 'tint'];
const HSL_KEYS = [...BANDS.map((b) => `hue_${b}`), ...BANDS.map((b) => `sat_${b}`), ...BANDS.map((b) => `lum_${b}`)];

function capRange(key) { const s = SLIDER_BY_KEY[key]; return s.ui; }

function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

function sampleIdx(n, count, pred, seed = 7) {
  const r = rng(seed), out = [];
  if (pred) { for (let i = 0; i < n; i++) if (pred(i)) out.push(i); }
  else for (let i = 0; i < n; i++) out.push(i);
  // partial Fisher-Yates
  for (let i = 0; i < Math.min(count, out.length); i++) { const j = i + Math.floor(r() * (out.length - i)); [out[i], out[j]] = [out[j], out[i]]; }
  return Int32Array.from(out.slice(0, count));
}

// Convert the fitted non-exposure tone map into an editable master point curve. The curve's x values
// are the grayscale sRGB values after Exposure; its y values are the same grayscale values after the
// fitted tonal shaping. This keeps Exposure available for brightness while curves carry the reference's
// contrast, highlight, shadow, black-point, and white-point character.
function toneTransferCurve(p, adaptive = false) {
  const fl = fadeLevels(p), points = [];
  for (let i = 0; i <= 32; i++) {
    const inputL = i * 100 / 32;
    const exposedL = 100 * exposeX(inputL, p);
    const outputL = toneMapL(inputL, p, fl);
    const x = Math.round(255 * linearToSrgb(lToY(exposedL)));
    const y = Math.round(255 * linearToSrgb(lToY(outputL)));
    if (points.length && x <= points[points.length - 1][0]) points[points.length - 1] = [x, y];
    else points.push([x, y]);
  }
  if (points[0]?.[0] !== 0) points.unshift([0, points[0]?.[1] ?? 0]);
  if (points[points.length - 1]?.[0] !== 255) points.push([255, points[points.length - 1]?.[1] ?? 255]);
  if (adaptive) {
    // The fitted tone controls can reverse locally. A reversing RGB curve turns
    // nearby input values into false contours, so project its samples onto the
    // nearest gently increasing curve before spline interpolation.
    const slope = Math.min(0.05, Math.max(0, (points.at(-1)[1] - points[0][1]) / 510));
    const blocks = [];
    for (let i = 0; i < points.length; i++) {
      const weight = i === 0 || i === points.length - 1 ? 1000 : 1;
      blocks.push({ first: i, last: i, sum: (points[i][1] - slope * points[i][0]) * weight, weight });
      while (blocks.length > 1) {
        const b = blocks.at(-1), a = blocks.at(-2);
        if (a.sum / a.weight <= b.sum / b.weight) break;
        a.last = b.last; a.sum += b.sum; a.weight += b.weight; blocks.pop();
      }
    }
    for (const block of blocks) for (let i = block.first; i <= block.last; i++) {
      points[i][1] = Math.max(0, Math.min(255, block.sum / block.weight + slope * points[i][0]));
    }
  }

  // Keep the automatically-created curve easy to inspect and edit without losing its shape.
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const simplify = (first, last) => {
    const [x0, y0] = points[first], [x1, y1] = points[last];
    let farthest = -1, distance = 1.35;
    for (let i = first + 1; i < last; i++) {
      const f = (points[i][0] - x0) / Math.max(1, x1 - x0);
      const d = Math.abs(points[i][1] - (y0 + f * (y1 - y0)));
      if (d > distance) { farthest = i; distance = d; }
    }
    if (farthest >= 0) { keep[farthest] = 1; simplify(first, farthest); simplify(farthest, last); }
  };
  simplify(0, points.length - 1);
  const out = points.filter((_, i) => keep[i]);
  // If simplification makes the spline reverse, keep the denser sampled curve instead.
  const lut = curveLUT(out, 256);
  for (let i = 1; i < lut.length; i++) if (lut[i] + 1e-5 < lut[i - 1]) return points;
  return out;
}

const RGB_CURVE_X = [64, 128, 192];
function rgbCurvesFromOffsets(offsets, amount = 1) {
  return ['curveR', 'curveG', 'curveB'].map((key, channel) => {
    const ys = RGB_CURVE_X.map((x, i) => x + offsets[channel * 3 + i] * amount);
    // Project adjacent anchors into a monotone range while retaining identity endpoints.
    const y1 = Math.max(1, Math.min(ys[0], 253));
    const y2 = Math.max(y1 + 1, Math.min(ys[1], 254));
    const y3 = Math.max(y2 + 1, Math.min(ys[2], 254));
    return [key, [[0, 0], [RGB_CURVE_X[0], y1], [RGB_CURVE_X[1], y2], [RGB_CURVE_X[2], y3], [255, 255]]];
  });
}

function fitReferenceRgbCurves(ps, T, params, sample, current) {
  if (T.strength <= 0) return null;
  const base = { ...params };
  const evaluate = (offsets) => {
    const curves = rgbCurvesFromOffsets(offsets);
    const candidate = { ...base, ...Object.fromEntries(curves) };
    processPixelSet(ps, candidate, sample, current);
    const st = measure(ps, current, sample);
    const residuals = [
      (st.wb.a - T.wb.a) / 0.8 * T.wb.weight,
      (st.wb.b - T.wb.b) / 0.8 * T.wb.weight,
    ];
    for (const z of ['shadows', 'midtones', 'highlights']) {
      const target = T.zones[z], have = st.zones[z];
      if (target && have) residuals.push((have.a - target.a) / 0.8 * target.weight, (have.b - target.b) / 0.8 * target.weight);
    }
    for (const q of [25, 50, 75]) residuals.push((st.tone.pct[q] - T.tone.pct[q]) / (q === 50 ? 2 : 3));
    return residuals;
  };
  const initial = new Array(9).fill(0);
  const lo = ['curveR', 'curveG', 'curveB'].flatMap(() => RGB_CURVE_X.map((x) => 1 - x));
  const hi = ['curveR', 'curveG', 'curveB'].flatMap(() => RGB_CURVE_X.map((x) => 254 - x));
  const fitted = lm((x) => evaluate(x), initial, lo, hi, { iters: 10, lambda0: 0.08 });
  if (!fitted.x.some((v) => Math.abs(v) > 0.75)) return null;
  const before = evaluate(initial).reduce((sum, v) => sum + v * v, 0);
  const after = evaluate(fitted.x).reduce((sum, v) => sum + v * v, 0);
  if (!(after < before - 1e-5)) return null;
  return { curves: Object.fromEntries(rgbCurvesFromOffsets(fitted.x)), evals: fitted.evals };
}

// ---------------- main entry ----------------------------------------------------------------------
/**
 * ps: PixelSet from prepare() on the photo's preview; o: measure(ps); ref: preset stats.
 * returns { params, targets, after, timings }
 */
export function solve(ps, o, ref, opts = {}) {
  const t0 = performance.now();
  const T = computeTargets(o, ref, opts);
  const params = defaultParams();
  if (opts.adaptive) params.curveSaturation = 0;

  // ---- stage A: tone (quantile mapping is exact for a monotonic luminance curve)
  let toneBias = Object.fromEntries(PCTS.map((p) => [p, 0]));
  const toneStage = () => {
    const lo = TONE_KEYS.map((k) => capRange(k)[0]), hi = TONE_KEYS.map((k) => capRange(k)[1]);
    const fn = (x) => {
      const p = { ...params }; TONE_KEYS.forEach((k, i) => (p[k] = x[i]));
      const fl = fadeLevels(p);
      const r = PCTS.map((q) => (toneMapL(o.tone.pct[q], p, fl) + toneBias[q] - T.tone.pct[q]) / (q === 50 ? 2 : 1.5));
      return r;
    };
    const res = lm(fn, TONE_KEYS.map((k) => params[k]), lo, hi, { iters: 40 });
    TONE_KEYS.forEach((k, i) => (params[k] = res.x[i]));
    return res;
  };

  // ---- stage B: white balance on supported neutral pixels
  const neutralIdx = sampleIdx(ps.n, 2500, (i) => ps.masks.neutral[i], 13);
  const wbIdx = neutralIdx;
  const cur = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  const wbStage = () => {
    const lo = WB_KEYS.map((k) => capRange(k)[0]), hi = WB_KEYS.map((k) => capRange(k)[1]);
    const w = T.wb.weight;
    const fn = (x) => {
      const p = { ...params }; WB_KEYS.forEach((k, i) => (p[k] = x[i]));
      processPixelSet(ps, p, wbIdx, cur);
      const st = measure(ps, cur, wbIdx);
      return [
        (st.wb.a - T.wb.a) / 0.6 * w, (st.wb.b - T.wb.b) / 0.6 * w,
      ];
    };
    const res = lm(fn, WB_KEYS.map((k) => params[k]), lo, hi, { iters: 20 });
    WB_KEYS.forEach((k, i) => (params[k] = res.x[i]));
    return res;
  };

  // ---- stage C: color (grading as Cartesian offsets, HSL, saturation, vibrance)
  const colorIdx = sampleIdx(ps.n, opts.colorSamples ?? 3000, null, 19);
  const colorSourceTone = opts.adaptive ? measure(ps, ps, colorIdx).tone.pct : null;
  const ZN = ['shadow', 'midtone', 'highlight'];
  const CKEYS = ['saturation', 'vibrance', 'su', 'sv', 'mu', 'mv', 'hu', 'hv', ...HSL_KEYS];
  const toParams = (x, base) => {
    const p = { ...base };
    const gradeAB = [];
    p.saturation = x[0]; p.vibrance = x[1];
    for (let z = 0; z < 3; z++) {
      const u = x[2 + z * 2], v = x[3 + z * 2];
      const magnitude = Math.hypot(u, v);
      const scale = magnitude > 100 ? 100 / magnitude : 1;
      const a = u * scale, b = v * scale, sat = Math.hypot(a, b);
      p[`${ZN[z]}Sat`] = sat;
      p[`${ZN[z]}Hue`] = sat > 1e-6 ? abToWheelHueFast(a, b) : 0;
      gradeAB.push([a, b]);
    }
    p._gradeAB = gradeAB;
    HSL_KEYS.forEach((k, i) => (p[k] = x[8 + i]));
    return p;
  };
  const colorStage = (iters) => {
    const lo = [], hi = [];
    CKEYS.forEach((k) => {
      if (opts.adaptive && !HSL_KEYS.includes(k)) { lo.push(0); hi.push(0); }
      else if (/^[smh][uv]$/.test(k)) { lo.push(-100); hi.push(100); }
      else if (HSL_KEYS.includes(k) && !T.bands[BANDS[HSL_KEYS.indexOf(k) % BANDS.length]]) { lo.push(0); hi.push(0); }
      else { const c = capRange(k); lo.push(c[0]); hi.push(c[1]); }
    });
    const x0 = CKEYS.map((k, i) => {
      if (i >= 2 && i < 8) {
        const z = Math.floor((i - 2) / 2), sat = params[`${ZN[z]}Sat`], [da, db] = wheelHueToAB(params[`${ZN[z]}Hue`]);
        return (i % 2 === 0 ? da : db) * sat;
      }
      return params[k];
    });
    const fn = (x) => {
      const p = toParams(x, params);
      processPixelSet(ps, p, colorIdx, cur);
      const st = measure(ps, cur, colorIdx);
      const r = [];
      if (opts.adaptive) for (const q of [5, 25, 50, 75, 95]) {
        // HSL luminance can undo the tone fit, especially after the master curve is
        // serialized. Preserve the reference's percentile shift on this same sample.
        const target = colorSourceTone[q] + T.tone.pct[q] - o.tone.pct[q];
        r.push((st.tone.pct[q] - target) / 2 * Math.min(1, T.strength * 20));
      }
      for (const z of ['shadows', 'midtones', 'highlights']) {
        const tz = T.zones[z];
        if (!tz) { r.push(0, 0); continue; }
        r.push((st.zones[z].a - tz.a) / 1.2 * tz.weight, (st.zones[z].b - tz.b) / 1.2 * tz.weight);
      }
      for (const b of BANDS) {
        const tb = T.bands[b];
        if (!tb) { r.push(0, 0, 0); continue; }
        const sb = opts.adaptive ? (st.bandsAdaptive || st.bandsBg || st.bands)[b] : st.bands[b];
        r.push(wrapDeg(sb.hue - tb.hue) / 12 * tb.weight, (sb.chroma - tb.chroma) / 2.5 * tb.weight, (sb.lumRel - tb.lumRel) / 4 * tb.weight);
      }
      if (T.color) r.push((st.color.meanChroma - T.color.meanChroma) / 0.8, (st.color.lowChroma - T.color.lowChroma) / 0.8);
      else r.push(0, 0);
      r.push((st.wb.a - T.wb.a) / 0.8 * T.wb.weight, (st.wb.b - T.wb.b) / 0.8 * T.wb.weight);
      // Small normalized ridge term stabilizes weakly identified color dimensions without narrowing UI ranges.
      x.forEach((v, i) => {
        const key = CKEYS[i];
        const range = /^[smh][uv]$/.test(key) ? 100 : Math.max(...SLIDER_BY_KEY[key].ui.map(Math.abs));
        r.push(0.03 * v / range);
      });
      if (opts.adaptive) {
        // Adjacent mixer bands overlap on real pixels. Penalize abrupt control jumps that
        // make color boundaries visible when the reference contains different objects.
        for (let offset = 8; offset < CKEYS.length; offset += BANDS.length) {
          for (let i = 0; i < BANDS.length; i++) {
            const next = (i + 1) % BANDS.length;
            r.push(0.18 * (x[offset + i] - x[offset + next]) / 100);
          }
        }
      }
      return r;
    };
    const res = lm(fn, x0, lo, hi, { iters });
    Object.assign(params, toParams(res.x, params));
    delete params._gradeAB;
    return res;
  };

  const tA = performance.now();
  const rA = toneStage();
  const tB = performance.now();
  const rB = wbStage();
  const tC = performance.now();
  const rC = colorStage(opts.colorIters ?? 10);
  const tD = performance.now();

  // ---- stage D: touch-up. Measure actual tone after color, fold the drift into the tone targets, re-solve tone + WB.
  const toneIdx = sampleIdx(ps.n, 8000, null, 23);
  processPixelSet(ps, params, toneIdx, cur);
  const mid = measure(ps, cur, toneIdx);
  const flp = fadeLevels(params);
  for (const q of PCTS) toneBias[q] = mid.tone.pct[q] - toneMapL(o.tone.pct[q], params, flp);
  toneStage();
  wbStage();
  const tE = performance.now();

  // Clip rates remain available in the reference targets as diagnostics; they never limit fitting.
  let guardK = 1;

  // Keep overall brightness in Exposure and express the reference-matched tonal shape as a real,
  // editable master curve. Refit color with that curve active because master curves also change the
  // chroma of colored pixels; the reference's color targets still decide the final WB/HSL/grade.
  const tCurve0 = performance.now();
  let rCurveColor = null;
  let rgbCurveEvals = 0;
  const matchedCurve = toneTransferCurve(params, opts.adaptive);
  params.curveAuto = 'reference';
  if (!isIdentityCurve(matchedCurve)) {
    params.curve = matchedCurve;
    for (const k of TONE_KEYS) if (k !== 'exposure') params[k] = 0;
    rCurveColor = colorStage(Math.min(6, opts.colorIters ?? 10));
  }

  const rgbFit = opts.adaptive ? null : fitReferenceRgbCurves(ps, T, params, sampleIdx(ps.n, 7000, null, 47), cur);
  if (rgbFit) { Object.assign(params, rgbFit.curves); rgbCurveEvals = rgbFit.evals; }

  // Keep fitted curves at their full strength; clipping remains a diagnostic.
  const tF = performance.now();
  const final = clampParams(params);
  for (const k of Object.keys(final)) if (SLIDER_BY_KEY[k] && !SLIDER_BY_KEY[k].hue) final[k] = Math.round(final[k] * (k === 'exposure' ? 100 : 1)) / (k === 'exposure' ? 100 : 1);
  return {
    params: final,
    targets: T,
    guardScale: guardK,
    timings: { tone: tB - tA, wb: tC - tB, color: tD - tC, touchup: tE - tD, curves: tF - tCurve0, total: tF - t0, evals: rA.evals + rB.evals + rC.evals + (rCurveColor?.evals || 0) + rgbCurveEvals },
  };
}

// cached wheel-hue lookup (abToWheelHue scans 360 entries; fine, but this is called a lot)
function abToWheelHueFast(a, b) { return abToWheelHue(a, b); }

export { TONE_KEYS, WB_KEYS, HSL_KEYS };

// ---------------- preset mode ------------------------------------------------------------------------
/**
 * Apply a Lightroom preset's exact values and only normalise the input photo first: an exposure and
 * white-balance offset so the photo walks into the preset the way a well-exposed, neutral file would.
 * Presets are built on files like that; a dark or orange phone shot pushed through one lands wrong.
 * presetParams: from lrpreset.toParams. opts.strength (0-1) scales the preset's own look.
 */
export function solvePreset(ps, o, presetParams, opts = {}) {
  const t0 = performance.now();
  const s = Math.min(1, Math.max(0, opts.strength ?? 1));
  // scale the look (not the normalisation) by strength; curves blend toward identity
  const look = { ...defaultParams() };
  for (const [k, v] of Object.entries(presetParams)) {
    if (Array.isArray(v)) look[k] = v.map(([x, y]) => [x, Math.round(x + (y - x) * s)]);
    else if (typeof v === 'number') look[k] = SLIDER_BY_KEY[k]?.hue ? v : v * s;
  }
  const idx = sampleIdx(ps.n, 6000, null, 41);
  const neutralIdx = sampleIdx(ps.n, 2500, (i) => ps.masks.neutral[i], 13);
  const cur = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  // target median: pull halfway toward a normal exposure, less for low-key scenes so night stays night
  const med0 = o.tone.pct[50];
  const lowKey = med0 < 25 || (opts.scene?.ev != null && opts.scene.ev < 7);
  const pull = opts.pull ?? 0.5; // photographer looks pass a gentler pull: their finish does the tone work
  const medT = med0 + (46 - med0) * (lowKey ? Math.min(0.2, pull) : pull);
  const wbW = neutralIdx.length > 200 ? 1 : 0.4;
  const fn = (x) => {
    const p = { ...defaultParams(), exposure: x[0], temp: x[1], tint: x[2] };
    processPixelSet(ps, p, idx, cur);
    const st = measure(ps, cur, idx);
    let na = 0, nb = 0;
    if (neutralIdx.length) { processPixelSet(ps, p, neutralIdx, cur); for (const i of neutralIdx) { na += cur.A[i]; nb += cur.B[i]; } na /= neutralIdx.length; nb /= neutralIdx.length; }
    return [
      (st.tone.pct[50] - medT) / 2,
      Math.max(0, st.tone.clipHi - o.tone.clipHi - 0.001) * 3000,
      // keep a little of the photo's own warmth (golden hour should stay golden)
      (na - 0.3 * o.wb.a) / 0.8 * wbW, (nb - 0.3 * o.wb.b) / 0.8 * wbW,
      x[0] / 1.2, x[1] / 80, x[2] / 80,
    ];
  };
  const res = lm(fn, [0, 0, 0], [-1.5, -60, -50], [1.5, 60, 50], { iters: 20 });
  const params = { ...look, exposure: (look.exposure || 0) + res.x[0], temp: (look.temp || 0) + res.x[1], tint: (look.tint || 0) + res.x[2] };
  params.exposure = Math.round(params.exposure * 100) / 100;
  params.temp = Math.round(params.temp); params.tint = Math.round(params.tint);
  return { params, targets: null, guardScale: 1, normalise: { exposure: res.x[0], temp: res.x[1], tint: res.x[2] }, timings: { total: performance.now() - t0, evals: res.evals } };
}
