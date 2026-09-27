// Solver: finds slider values that bring THIS photo's measurements to the preset's targets.
// Staged bounded Levenberg-Marquardt: tone -> white balance -> color -> tone/WB touch-up.

import { PCTS, BANDS, measure } from './measure.js';
import { SLIDERS, SLIDER_BY_KEY, defaultParams, toneMapL, toneRaw, toneMaxSlope, toneReversal, fadeLevels, processPixelSet, clampParams } from './pipeline.js';
import { wheelHueToAB, abToWheelHue, wrapDeg } from './color.js';
import { brightenFactor } from './scene.js';

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
const hinge = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);

// How much of the reference's tone shape to copy, by percentile. The ends (black point, white point,
// fades, crushed or rolled-off highlights) are mostly the edit; the middle of the histogram is mostly
// what was in the scene, so copying it makes this photo's content look like the reference's content.
export const TONE_SHAPE = { 1: 1, 5: 0.5, 10: 0.2, 25: 0, 50: 1, 75: 0, 90: 0.2, 95: 0.5, 99: 1 };

// Zone tints and HSL bands mix the grade with whatever colors were in the scene. Only part of the
// measured difference is trusted as the edit (tested on tools/solver_eval.mjs).
export const ZONE_MOVE = 0.5;
export const BAND_MOVE = 0.5;

// How far toward the reference's brightness, and how much of that survives when the photo is darker.
// 2026-09-27: the old 0.5 pull x a dark-photo factor down to 0.15 x the same factor again on every
// brightening move left a dim photo matched to a high-key reference (Pepsi) within 2 L* of where it
// started. A reference's brightness is a large part of its look, so most of it is now kept.
export const BRIGHTNESS_PULL = 0.75;
// The reference's black and white points are copied as absolute values, not stretched around the new
// median: a reference whose whites stop at 88 L* should put this photo's whites near 88, not at 74.
export const END_ABS = { 1: 1, 5: 0.5, 95: 0.5, 99: 1 };
// Most the overall colourfulness may be multiplied by (was 1.5: a 4x more colourful reference got 1.5x).
export const CHROMA_CAP = 2.2;
// How much duller a colour gets when the reference doesn't have it at all.
export const ABSENT_BAND_DULL = 0.2;

export function computeTargets(o, ref, { strength = 1, brightnessPull = BRIGHTNESS_PULL, scene = null, toneShape = TONE_SHAPE, zoneMove = ZONE_MOVE, bandMove = BAND_MOVE, endAbs = END_ABS, chromaCap = CHROMA_CAP } = {}) {
  const s = Math.min(1, Math.max(0, strength));
  const o50 = o.tone.pct[50], r50 = ref.tone.pct[50];
  // weight relative look over absolute brightness: only part of the way to the reference's median,
  // and less when the photo is a low-key / night frame being pulled up.
  let pull = brightnessPull;
  let lift = 1; // how much of any brightening move to keep (dark scenes stay darker all through the range)
  if (o50 < r50) {
    const byImage = Math.min(1, Math.max(0.45, (o50 - 4) / 20));
    const byScene = brightenFactor(scene);
    // camera settings, when present, decide whether "dark" means a dark scene or an underexposed bright one
    const f = byScene == null ? byImage : byScene;
    pull *= f;
    lift = Math.max(0.6, Math.sqrt(f));
  }
  const anchor = o50 + pull * (r50 - o50);
  const below = anchor / Math.max(1, r50), above = (100 - anchor) / Math.max(1, 100 - r50);
  const pct = {};
  for (const p of PCTS) {
    const d = ref.tone.pct[p] - r50;
    let full = Math.min(100, Math.max(0, anchor + d * (d < 0 ? below : above)));
    // black / white point as the reference has them, but never across the new median
    const ea = endAbs[p] || 0;
    if (ea) full += ea * ((p < 50 ? Math.min(ref.tone.pct[p], anchor - 2) : Math.max(ref.tone.pct[p], anchor + 2)) - full);
    // this photo's own shape, moved to the new median
    const dO = o.tone.pct[p] - o50;
    const own = Math.min(100, Math.max(0, anchor + dO * (dO < 0 ? anchor / Math.max(1, o50) : (100 - anchor) / Math.max(1, 100 - o50))));
    const w = toneShape[p] ?? 1;
    const move = own + w * (full - own) - o.tone.pct[p];
    pct[p] = o.tone.pct[p] + s * move * (move > 0 ? lift : 1);
  }
  const wbConf = Math.min(1, o.wb.confidence / 0.4) * Math.min(1, ref.wb.confidence / 0.4);
  const sw = s * wbConf;
  const wb = { a: o.wb.a + sw * (ref.wb.a - o.wb.a), b: o.wb.b + sw * (ref.wb.b - o.wb.b), weight: 0.3 + 0.7 * wbConf };
  const zones = {};
  for (const z of ['shadows', 'midtones', 'highlights']) {
    const mass = Math.min(o.zones[z].mass, ref.zones[z].mass);
    if (mass < 0.02) continue;
    const zs = s * zoneMove;
    zones[z] = { a: o.zones[z].a + zs * (ref.zones[z].a - o.zones[z].a), b: o.zones[z].b + zs * (ref.zones[z].b - o.zones[z].b), weight: Math.sqrt(Math.min(1, mass / 0.1)) };
  }
  const bands = {};
  for (const b of BANDS) {
    const ob = o.bands[b], rb = ref.bands[b];
    // a colour this photo has and the reference doesn't: hold it, a little duller, so the overall
    // colourfulness target is met in the reference's colours (a teal floor stayed teal and got
    // louder under a warm, teal-free reference)
    if (ob.weight >= 0.008 && rb.weight < 0.008) {
      bands[b] = { hue: ob.hue, chroma: ob.chroma * (1 - ABSENT_BAND_DULL * s), lumRel: ob.lumRel, weight: Math.sqrt(Math.min(1, ob.weight / 0.05)) };
      continue;
    }
    if (ob.weight < 0.008 || rb.weight < 0.008) continue;
    const dh = Math.max(-25, Math.min(25, wrapDeg(rb.hue - ob.hue)));
    const ratio = Math.max(0.5, Math.min(1.6, rb.chroma / Math.max(1, ob.chroma)));
    bands[b] = {
      hue: ob.hue + s * bandMove * dh,
      chroma: ob.chroma * Math.pow(ratio, s * bandMove),
      lumRel: ob.lumRel + s * bandMove * Math.max(-15, Math.min(15, rb.lumRel - ob.lumRel)),
      weight: Math.sqrt(Math.min(1, Math.min(ob.weight, rb.weight) / 0.05)),
    };
  }
  const cr = (a, b) => Math.max(0.55, Math.min(chromaCap, b / Math.max(0.5, a)));
  const color = {
    meanChroma: o.color.meanChroma * Math.pow(cr(o.color.meanChroma, ref.color.meanChroma), s),
    lowChroma: o.color.lowChroma * Math.pow(cr(o.color.lowChroma, ref.color.lowChroma), s),
  };
  const clip = {
    hi: Math.max(o.tone.clipHi, ref.tone.clipHi) + 0.001,
    lo: Math.max(o.tone.clipLo, ref.tone.clipLo) + 0.001,
  };
  const skin = { hue: o.skin.hue, chroma: o.skin.chroma, spread: o.skin.hueSpread, litHue: o.skin.litHue, litChroma: o.skin.litChroma, active: o.skin.source === 'faces' ? o.skin.frac > 0.0004 : o.skin.frac > 0.005 };
  return { tone: { pct }, wb, zones, bands, color, clip, skin, strength: s, anchor };
}

// ---------------- stage residuals ------------------------------------------------------------------
const TONE_KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'fadeBlacks', 'fadeWhites'];
const WB_KEYS = ['temp', 'tint'];
const HSL_KEYS = [...BANDS.map((b) => `hue_${b}`), ...BANDS.map((b) => `sat_${b}`), ...BANDS.map((b) => `lum_${b}`)];

function capRange(key) { const s = SLIDER_BY_KEY[key]; return s.cap; }

function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

function sampleIdx(n, count, pred, seed = 7) {
  const r = rng(seed), out = [];
  if (pred) { for (let i = 0; i < n; i++) if (pred(i)) out.push(i); }
  else for (let i = 0; i < n; i++) out.push(i);
  // partial Fisher-Yates
  for (let i = 0; i < Math.min(count, out.length); i++) { const j = i + Math.floor(r() * (out.length - i)); [out[i], out[j]] = [out[j], out[i]]; }
  return Int32Array.from(out.slice(0, count));
}

function skinResiduals(st, t) {
  if (!t.skin.active || st.skin.frac < 0.0003) return [0, 0, 0, 0, 0, 0];
  return [
    // believable skin hue window (Lab hue angle); a photo already outside it (colored stage light) may not get worse
    hinge(st.skin.hue, Math.min(35, t.skin.hue - 2), Math.max(64, t.skin.hue + 2)) / 1.5,
    hinge(wrapDeg(st.skin.hue - t.skin.hue), -6, 6) / 1.5, // don't swing skin more than ~6 degrees
    hinge(st.skin.chroma / Math.max(1, t.skin.chroma), 0.68, 1.4) * 15,
    Math.max(0, st.skin.hueSpread - t.skin.spread - 2) / 1,  // blotchy skin = hue spread grows
    hinge(wrapDeg(st.skin.litHue - t.skin.litHue), -6, 6) / 1.5,          // lit side of faces
    hinge(st.skin.litChroma / Math.max(1, t.skin.litChroma), 0.75, 1.4) * 40,
  ];
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
  const reg = opts.regularization ?? 1;

  // sorted luminance sample for fast tone-stage clipping estimates
  const lumSample = sampleIdx(ps.n, 3000, null, 11);
  const Ls = Float64Array.from(lumSample, (i) => ps.L[i]);

  // ---- stage A: tone (quantile mapping is exact for a monotonic luminance curve)
  let toneBias = Object.fromEntries(PCTS.map((p) => [p, 0]));
  // Noise: stretching the darkest tones of a high-ISO frame turns sensor noise into blotches.
  const iso = opts.scene?.iso || 0;
  const noisy = iso >= 3200 || (!iso && o.tone.pct[50] < 12);
  const darkSlopeCap = !noisy ? Infinity : iso >= 8000 ? 1.35 : 1.6;
  const darkSlope = (p, fl) => { let mx = 0, prev = toneMapL(0, p, fl); for (let L = 2; L <= 30; L += 2) { const v = toneMapL(L, p, fl); mx = Math.max(mx, (v - prev) / 2); prev = v; } return mx; };
  // faces: keep their brightness. Copying rolled-off highlights must not drag a face that happens to be
  // the brightest thing in a dark frame down to mid-grey (it reads as grey, lifeless skin).
  const litSkin = [], allSkin = [];
  for (let i = 0; i < ps.n; i += 3) { if (ps.masks.skin[i] === 2) litSkin.push(ps.L[i]); if (ps.masks.skin[i]) allSkin.push(ps.L[i]); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const litSkin0 = mean(litSkin), allSkin0 = mean(allSkin);
  const brightSkin = litSkin.slice().sort((a, b) => a - b).slice(Math.floor(litSkin.length * 0.8));
  const brightSkin0 = mean(brightSkin);
  const faceWeight = ps.skinSource === 'faces' ? 1 : 0.5;
  let clipBias = { hi: 0, lo: 0 };
  // risk set: bright pixels whose channels can hit the gamut edge; run through the full pipeline in the tone stage
  const riskAll = [];
  for (let i = 0; i < ps.n; i++) if (Math.max(ps.lr[i], ps.lg[i], ps.lb[i]) > 0.35) riskAll.push(i);
  const riskShare = riskAll.length / ps.n;
  const riskIdx = sampleIdx(ps.n, 600, (i) => Math.max(ps.lr[i], ps.lg[i], ps.lb[i]) > 0.35, 29);
  const riskCur = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  const riskClip = (p) => {
    if (!riskIdx.length) return 0;
    processPixelSet(ps, p, riskIdx, riskCur);
    let c = 0;
    for (const i of riskIdx) { const m = Math.max(riskCur.lr[i], riskCur.lg[i], riskCur.lb[i]); c += 1 / (1 + Math.exp(-(m - 0.993) / 0.002)); }
    return (c / riskIdx.length) * riskShare;
  };
  let origNearWhite = 0; for (let i = 0; i < Ls.length; i++) if (Ls[i] >= 97) origNearWhite++; origNearWhite /= Ls.length;
  const nearWhite = (p) => { let c = 0; for (let i = 0; i < Ls.length; i++) { const v = toneRaw(Ls[i], p); c += 1 / (1 + Math.exp(-(v - 97) / 0.5)); } return c / Ls.length; };
  const predictClip = (p) => { let h = 0, l = 0; for (let i = 0; i < Ls.length; i++) { const v = toneRaw(Ls[i], p); h += 1 / (1 + Math.exp(-(v - 99.2) / 0.4)); l += 1 / (1 + Math.exp((v - 0.6) / 0.3)); } return { hi: h / Ls.length, lo: l / Ls.length }; };
  let useRisk = false;
  const toneStage = () => {
    const lo = TONE_KEYS.map((k) => capRange(k)[0]), hi = TONE_KEYS.map((k) => capRange(k)[1]);
    const fn = (x) => {
      const p = { ...params }; TONE_KEYS.forEach((k, i) => (p[k] = x[i]));
      const fl = fadeLevels(p);
      const r = PCTS.map((q) => (toneMapL(o.tone.pct[q], p, fl) + toneBias[q] - T.tone.pct[q]) / (q === 50 ? 2 : 1.5));
      const { hi: hiL, lo: loC } = predictClip(p);
      const hiC = useRisk ? Math.max(hiL, riskClip(p)) : hiL + clipBias.hi;
      r.push(Math.max(0, hiC - T.clip.hi) * 3000, Math.max(0, loC + clipBias.lo - T.clip.lo) * 3000);
      r.push(Math.max(0, toneMaxSlope(p) - 2.2) * 6);
      r.push(toneReversal(p) * 8);
      r.push(Number.isFinite(darkSlopeCap) ? Math.max(0, darkSlope(p, fl) - darkSlopeCap) * 12 : 0);
      if (litSkin.length > 20) {
        const lit1 = litSkin.reduce((a, L) => a + toneMapL(L, p, fl), 0) / litSkin.length + toneBias[50] * 0;
        const all1 = allSkin.reduce((a, L) => a + toneMapL(L, p, fl), 0) / allSkin.length;
        const br1 = brightSkin.reduce((a, L) => a + toneMapL(L, p, fl), 0) / Math.max(1, brightSkin.length);
        r.push(faceWeight * hinge(lit1 - litSkin0, -4, 14) / 1.2, faceWeight * hinge(all1 - allSkin0, -5, 14) / 1.2, faceWeight * hinge(br1 - brightSkin0, -6, 14) / 1.2);
      } else r.push(0, 0, 0);
      r.push(Math.max(0, nearWhite(p) - origNearWhite - 0.004) * 600);
      TONE_KEYS.forEach((k, i) => { const c = capRange(k); r.push(1.8 * reg * x[i] / (c[1] - c[0])); });
      return r;
    };
    const res = lm(fn, TONE_KEYS.map((k) => params[k]), lo, hi, { iters: 40 });
    TONE_KEYS.forEach((k, i) => (params[k] = res.x[i]));
    return res;
  };

  // ---- stage B: white balance on the photo's neutral pixels (+ skin guard)
  const neutralIdx = sampleIdx(ps.n, 2500, (i) => ps.masks.neutral[i], 13);
  const skinIdx = sampleIdx(ps.n, 1500, (i) => ps.masks.skin[i], 17);
  const wbIdx = Int32Array.from([...neutralIdx, ...skinIdx]);
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
        ...skinResiduals(st, T),
        useRisk ? Math.max(0, riskClip(p) - T.clip.hi) * 3000 : 0,
        0.3 * reg * x[0] / 100, 0.3 * reg * x[1] / 100,
      ];
    };
    const res = lm(fn, WB_KEYS.map((k) => params[k]), lo, hi, { iters: 20 });
    WB_KEYS.forEach((k, i) => (params[k] = res.x[i]));
    return res;
  };

  // ---- stage C: color (grading as Cartesian offsets, HSL, saturation, vibrance)
  const colorIdx = sampleIdx(ps.n, opts.colorSamples ?? 3000, null, 19);
  const ZN = ['shadow', 'midtone', 'highlight'];
  const CKEYS = ['saturation', 'vibrance', 'su', 'sv', 'mu', 'mv', 'hu', 'hv', ...HSL_KEYS];
  const toParams = (x, base) => {
    const p = { ...base };
    p.saturation = x[0]; p.vibrance = x[1];
    for (let z = 0; z < 3; z++) {
      const u = x[2 + z * 2], v = x[3 + z * 2];
      const sat = Math.hypot(u, v);
      p[`${ZN[z]}Sat`] = Math.min(35, sat);
      p[`${ZN[z]}Hue`] = sat > 1e-6 ? abToWheelHueFast(u, v) : 0;
    }
    p._gradeAB = [[x[2], x[3]], [x[4], x[5]], [x[6], x[7]]];
    HSL_KEYS.forEach((k, i) => (p[k] = x[8 + i]));
    return p;
  };
  const colorStage = (iters) => {
    const lo = [], hi = [];
    CKEYS.forEach((k) => {
      if (/^[smh][uv]$/.test(k)) { lo.push(-35); hi.push(35); }
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
      for (const z of ['shadows', 'midtones', 'highlights']) {
        const tz = T.zones[z];
        if (!tz) { r.push(0, 0); continue; }
        r.push((st.zones[z].a - tz.a) / 1.2 * tz.weight, (st.zones[z].b - tz.b) / 1.2 * tz.weight);
      }
      for (const b of BANDS) {
        const tb = T.bands[b];
        if (!tb) { r.push(0, 0, 0); continue; }
        const sb = st.bands[b];
        r.push(wrapDeg(sb.hue - tb.hue) / 12 * tb.weight, (sb.chroma - tb.chroma) / 2.5 * tb.weight, (sb.lumRel - tb.lumRel) / 4 * tb.weight);
      }
      r.push((st.color.meanChroma - T.color.meanChroma) / 0.8, (st.color.lowChroma - T.color.lowChroma) / 0.8);
      r.push((st.wb.a - T.wb.a) / 0.8 * T.wb.weight, (st.wb.b - T.wb.b) / 0.8 * T.wb.weight);
      r.push(...skinResiduals(st, T));
      r.push(Math.max(0, st.tone.clipHi - T.clip.hi) * 3000, Math.max(0, st.tone.clipLo - T.clip.lo) * 3000);
      // saturation and vibrance pulling opposite ways is the same look with worse skin; discourage it
      r.push(3 * reg * Math.max(0, -x[0] * x[1]) / 2500);
      // neighbouring HSL bands must not diverge (that is what makes skin blotchy)
      for (let g = 0; g < 3; g++) for (let bnd = 0; bnd < 8; bnd++) {
        const i1 = 8 + g * 8 + bnd, i2 = 8 + g * 8 + ((bnd + 1) % 8);
        const skinPair = bnd === 0 || bnd === 1; // red-orange, orange-yellow: skin straddles these
        r.push((skinPair ? 6 : 2) * reg * (x[i1] - x[i2]) / (hi[i1] - lo[i1]));
      }
      x.forEach((v, i) => {
        // HSL sliders for bands with no target (or little pixel support) are held near zero
        let w = i < 2 ? 0.4 : i < 8 ? 0.3 : 0.8;
        if (i >= 8) { const band = BANDS[(i - 8) % 8]; if (!T.bands[band]) w = 1.2; else w /= Math.max(0.3, T.bands[band].weight); }
        r.push(w * reg * v / (hi[i] - lo[i]));
      });
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
  const pc = predictClip(params);
  clipBias = { hi: Math.max(0, mid.tone.clipHi - pc.hi), lo: Math.max(0, mid.tone.clipLo - pc.lo) };
  useRisk = true;
  toneStage();
  wbStage();
  const tE = performance.now();

  // ---- guardrail: if real clipping still exceeds what's allowed, scale the edit back until it doesn't
  const guardIdx = sampleIdx(ps.n, 12000, null, 31);
  const clipOf = (p) => { processPixelSet(ps, p, guardIdx, cur); const st = measure(ps, cur, guardIdx); return st.tone; };
  const scaled = (k) => { const q = { ...params }; for (const sl of SLIDERS) if (!sl.hue && sl.key !== 'temp' && sl.key !== 'tint') q[sl.key] = params[sl.key] * k; return q; };
  let guardK = 1;
  const over = (c) => c.clipHi > T.clip.hi - 0.0006 || c.clipLo > T.clip.lo - 0.0006;
  const BRIGHT = (k, v) => (k === 'exposure' || k === 'highlights' || k === 'whites' || k === 'contrast' || k.startsWith('lum_')) && v > 0
    || (k === 'blacks' || k === 'shadows') && v < 0;
  const scaledBright = (k2) => { const q = { ...params }; for (const sl of SLIDERS) if (BRIGHT(sl.key, params[sl.key])) q[sl.key] = params[sl.key] * k2; return q; };
  if (over(clipOf(params))) {
    if (!over(clipOf(scaledBright(0)))) {
      let lo = 0, hi = 1;
      for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (over(clipOf(scaledBright(m)))) hi = m; else lo = m; }
      Object.assign(params, scaledBright(lo));
      guardK = 0.999; // partial, targeted
    } else {
      let lo = 0, hi = 1;
      for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (over(clipOf(scaled(m)))) hi = m; else lo = m; }
      guardK = lo;
      Object.assign(params, scaled(lo));
    }
  }
  const final = clampParams(params, true);
  for (const k of Object.keys(final)) if (SLIDER_BY_KEY[k] && !SLIDER_BY_KEY[k].hue) final[k] = Math.round(final[k] * (k === 'exposure' ? 100 : 1)) / (k === 'exposure' ? 100 : 1);
  return {
    params: final,
    targets: T,
    guardScale: guardK,
    timings: { tone: tB - tA, wb: tC - tB, color: tD - tC, touchup: tE - tD, total: tE - t0, evals: rA.evals + rB.evals + rC.evals },
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
