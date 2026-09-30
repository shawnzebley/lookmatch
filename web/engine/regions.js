// Subject vs background. After the whole-photo edit is solved, the style decides how the subject should
// sit against its background: how much brighter or darker, warmer or cooler, more or less colourful.
// Those three relations are fitted with a few local sliders per region (exposure, temp, tint, saturation)
// while the photo as a whole stays where the whole-photo edit put it.

import { processPixelSet } from './pipeline.js';
import { BANDS, PCTS, regionStats, regionUsable } from './measure.js';
import { lm } from './solver.js';
import { counts } from './loss.js';
import { linearToSrgb, lToY } from './color.js';

// Share of the gap closed. Much of how a subject sits against its background in any one photo is the
// light it was shot in, not the edit, so only part of the difference is copied, and no more than
// STEP of each relation per photo (a photographer's subject mask is a nudge, not a relight).
export const REGION_MOVE = 0.4;
const STEP = { sep: 6, dA: 3, dB: 3, logC: 0.22 };
// A reference photo is the look Shawn asked for, so its warm-subject / cool-background split is copied
// further than a photographer's averages. Darkening or dulling the subject against its background is
// still mostly the reference's own scene (Pepsi: a bright cyan backdrop behind the model), so those
// barely move, and cooling the subject against its background (dark clothes on a warm grey wall read as a
// cool subject) goes a quarter as far.
export const REF_REGION = { move: 0.65, step: { sep: 6, dA: 9, dB: 9, logC: 0.3 }, darken: 0.1, dull: 0.1, cool: 0.25 };
const KEYS = ['exposure', 'temp', 'tint', 'saturation'];
const CAP = { exposure: 0.5, temp: 25, tint: 20, saturation: 30 };
const SCALE = { exposure: 0.5, temp: 30, tint: 30, saturation: 30 };
const EXPOSURE_GAP = 0.7; // most the two regions' exposures may differ (halos along the mask edge beyond that)

function sampleIdx(n, count = 9000) {
  const step = Math.max(1, Math.floor(n / count)), a = [];
  for (let i = 0; i < n; i += step) a.push(i);
  return Int32Array.from(a);
}

const hueDeg = (a, b) => { let h = (Math.atan2(b, a) * 180) / Math.PI; return h < 0 ? h + 360 : h; };
const wrap = (d) => ((d + 540) % 360) - 180;

function skinStats(ps, cur, idx) {
  const sk = ps.masks && ps.masks.skin;
  if (!sk) return null;
  let a = 0, b = 0, n = 0;
  for (const i of idx) if (sk[i] && ps.subject[i] >= 128) { a += cur.A[i]; b += cur.B[i]; n++; }
  return n > 40 ? [a / n, b / n] : null;
}

/**
 * Targets for this photo from a set of relations: want = { sep, dA, dB, logC } (a reference's, or a
 * photographer's similar published photos). move scales how far toward them this photo goes.
 */
export function regionTargets(now, want, move = REGION_MOVE, { step = STEP, darken = 0.35, dull = 0.5, cool = 1 } = {}) {
  if (!now || !want) return null;
  // Pulling the subject back into its background (darker, or duller than it) is the rarer edit, and
  // usually the scene's own light rather than a choice, so those moves go a third / half as far.
  const t = (k) => {
    if (want[k] == null || Number.isNaN(want[k])) return now[k];
    let d = (want[k] - now[k]) * move;
    if (d < 0 && k === 'sep') d *= darken;
    if (d < 0 && k === 'logC') d *= dull;
    if (d < 0 && (k === 'dA' || k === 'dB')) d *= cool;
    return now[k] + Math.max(-step[k], Math.min(step[k], d));
  };
  return { sep: t('sep'), dA: t('dA'), dB: t('dB'), logC: t('logC'), move, want };
}

/**
 * Fit local amounts for subject and background. params: the solved whole-photo edit (may already carry
 * params.local, which is replaced). want: { sep, dA, dB, logC }. Returns { params, regions } or null
 * when the photo has no usable subject/background split.
 */
export function fitRegions(ps, params, want, { move = REGION_MOVE, idx = null, step = STEP, darken = 0.35, dull = 0.5, cool = 1 } = {}) {
  if (!ps.subject || !want) return null;
  idx = idx || sampleIdx(ps.n);
  const n = ps.n;
  const cur = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const base = { ...params };
  delete base.local;
  const st0 = regionStats(ps, processPixelSet(ps, base, idx, cur), idx, { details: false });
  if (!regionUsable(st0)) return null;
  const T = regionTargets(st0, want, move, { step, darken, dull, cool });
  const clip0 = counts(ps, cur, idx);
  const skin0 = skinStats(ps, cur, idx);
  const f = st0.frac;
  // what holds the whole photo in place: area-weighted brightness, tint and colour of the two regions
  // (means, not medians, inside the fit: a median barely moves for the small steps the solver probes with)
  const whole = (s) => ({
    L: f * s.subject.mL + (1 - f) * s.background.mL,
    a: f * s.subject.a + (1 - f) * s.background.a,
    b: f * s.subject.b + (1 - f) * s.background.b,
    C: f * s.subject.C + (1 - f) * s.background.C,
  });
  const w0 = whole(st0);
  const mSep0 = st0.subject.mL - st0.background.mL;
  const toLocal = (x) => ({
    subject: Object.fromEntries(KEYS.map((k, j) => [k, x[j]])),
    background: Object.fromEntries(KEYS.map((k, j) => [k, x[4 + j]])),
  });
  const fn = (x) => {
    const p = { ...base, local: toLocal(x) };
    const s = regionStats(ps, processPixelSet(ps, p, idx, cur), idx, { details: false });
    const w = whole(s);
    const c = counts(ps, cur, idx);
    const r = [
      ((s.subject.mL - s.background.mL) - mSep0 - (T.sep - st0.sep)) / 1.2,
      (s.dA - T.dA) / 0.8, (s.dB - T.dB) / 0.8,
      (s.logC - T.logC) / 0.06,
      (w.L - w0.L) / 1.5, (w.a - w0.a) / 1, (w.b - w0.b) / 1, (w.C - w0.C) / 0.8,
      Math.max(0, c.blown - clip0.blown - 0.1) * 20, Math.max(0, c.crushed - clip0.crushed - 0.1) * 20, Math.max(0, c.color - clip0.color - 0.2) * 10,
      Math.max(0, Math.abs(x[0] - x[4]) - EXPOSURE_GAP) * 30,
    ];
    if (skin0) {
      const sk = skinStats(ps, cur, idx);
      if (sk) r.push(Math.max(0, Math.abs(wrap(hueDeg(...sk) - hueDeg(...skin0))) - 4) / 1.5);
    }
    x.forEach((v, j) => r.push(v / SCALE[KEYS[j % 4]] * 0.6));
    return r;
  };
  const lo = [...KEYS, ...KEYS].map((k) => -CAP[k]), hi = [...KEYS, ...KEYS].map((k) => CAP[k]);
  const res = lm(fn, new Array(8).fill(0), lo, hi, { iters: 18 });
  const round = (k, v) => (k === 'exposure' ? Math.round(v * 100) / 100 : Math.round(v));
  const local = toLocal(res.x);
  for (const r of ['subject', 'background']) for (const k of KEYS) local[r][k] = round(k, local[r][k]);
  const out = { ...base, local };
  const st1 = regionStats(ps, processPixelSet(ps, out, idx, cur), idx, { details: false });
  const r1 = (v) => Math.round(v * 10) / 10;
  const rel = (s) => ({ sep: r1(s.sep), dA: r1(s.dA), dB: r1(s.dB), chroma: Math.round(Math.exp(s.logC) * 100) / 100 });
  return {
    params: out,
    regions: {
      frac: Math.round(st0.frac * 1000) / 1000,
      before: rel(st0), after: rel(st1),
      target: rel({ sep: T.sep, dA: T.dA, dB: T.dB, logC: T.logC }),
      theirs: rel({ sep: want.sep ?? st0.sep, dA: want.dA ?? st0.dA, dB: want.dB ?? st0.dB, logC: want.logC ?? st0.logC }),
      local,
    },
  };
}

const hueDiff = (a, b) => ((a - b + 540) % 360) - 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lstarToGray = (L) => Math.round(255 * linearToSrgb(lToY(clamp(L, 0, 100))));

function subjectReferenceCurve(now, target, move) {
  if (!now || !target || !now.pct || !target.pct) return null;
  const transfer = (a, b, limit) => a + clamp(b - a, -limit, limit) * move;
  const pairs = [[0, lstarToGray(transfer(now.black, target.black, 8))]];
  for (const p of PCTS) {
    const x = lstarToGray(now.pct[p]);
    const y = lstarToGray(transfer(now.pct[p], target.pct[p], 12));
    pairs.push([x, y]);
  }
  pairs.push([255, lstarToGray(transfer(now.white, target.white, 8))]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [x, y] of pairs) {
    const py = Math.max(out.length ? out[out.length - 1][1] : 0, Math.min(255, y));
    if (out.length && x === out[out.length - 1][0]) out[out.length - 1][1] = py;
    else out.push([x, py]);
  }
  if (out[0][0] !== 0) out.unshift([0, out[0][1]]);
  if (out[out.length - 1][0] !== 255) out.push([255, out[out.length - 1][1]]);
  return out.every(([x, y]) => x === y) ? null : out;
}

/** A photo reference contributes three distinct cues: subject white balance and tone shape, and
 * background HSL color relationships. The photographer profile path continues to use fitRegions(). */
export function fitReferenceRegions(ps, params, want, opts = {}) {
  const move = clamp(opts.move ?? 0.5, 0, 0.7);
  const relation = fitRegions(ps, params, want, { ...opts, move });
  if (!relation || !want.subject || !want.background) return relation;
  const idx = sampleIdx(ps.n, 5000), cur = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  const local = { subject: { ...relation.params.local.subject }, background: { ...relation.params.local.background } };
  // A photographic reference's background receives its color style through HSL; local WB belongs to
  // the subject so that a warm or pink subject does not recolor the whole backdrop.
  local.background.temp = 0; local.background.tint = 0;
  let working = { ...relation.params, local };
  const refit = (p) => regionStats(ps, processPixelSet(ps, p, idx, cur), idx);
  let st = refit(working);

  // Fit subject WB toward the reference's neutral-pixel cast when available, otherwise its low-chroma
  // subject tint. Skin hue/chroma acts as an additional anchor when both photos contain enough skin.
  const targetSub = want.subject, currentSub = st && st.subject;
  if (currentSub && targetSub.n > 200) {
    const neutralPair = currentSub.wb.pixels >= 12 && targetSub.wb && targetSub.wb.pixels >= 12;
    const aKey = neutralPair ? 'wb' : null;
    const sourceA = aKey ? currentSub.wb.a : currentSub.a, sourceB = aKey ? currentSub.wb.b : currentSub.b;
    const targetA = aKey ? targetSub.wb.a : targetSub.a, targetB = aKey ? targetSub.wb.b : targetSub.b;
    const aimA = sourceA + (targetA - sourceA) * move, aimB = sourceB + (targetB - sourceB) * move;
    const skinAim = currentSub.skin && targetSub.skin
      ? { hue: currentSub.skin.hue + hueDiff(targetSub.skin.hue, currentSub.skin.hue) * move,
          chroma: currentSub.skin.chroma + (targetSub.skin.chroma - currentSub.skin.chroma) * move }
      : null;
    const baseTemp = local.subject.temp || 0, baseTint = local.subject.tint || 0;
    const fn = (x) => {
      const trial = { ...working, local: { ...local, subject: { ...local.subject, temp: baseTemp + x[0], tint: baseTint + x[1] } } };
      const q = refit(trial), v = q && q.subject;
      if (!v) return [0, 0, x[0] / 12, x[1] / 12];
      const va = aKey ? v.wb.a : v.a, vb = aKey ? v.wb.b : v.b;
      const r = [(va - aimA) / 1.5, (vb - aimB) / 1.5];
      if (skinAim && v.skin) r.push(hueDiff(v.skin.hue, skinAim.hue) / 5, (v.skin.chroma - skinAim.chroma) / 4);
      r.push(x[0] / 14, x[1] / 14);
      return r;
    };
    const fit = lm(fn, [0, 0], [-18, -18], [18, 18], { iters: 10 });
    local.subject.temp = Math.round(clamp(baseTemp + fit.x[0], -35, 35));
    local.subject.tint = Math.round(clamp(baseTint + fit.x[1], -30, 30));
    working = { ...working, local };
    st = refit(working);
  }

  // Make the subject's measured tone distribution approach the reference with a smooth, monotone
  // editable point curve. Exposure remains available as a separate correction.
  const curve = subjectReferenceCurve(st && st.subject && st.subject.tone, targetSub.tone, move);
  if (curve) { local.subject.curve = curve; local.subject.curveAmount = 100; local.subject.curveAuto = 'reference'; }
  working = { ...working, local };
  st = refit(working);

  // Reproduce the reference's background palette with bounded, per-hue HSL moves. Empty or nearly
  // empty hue bands are ignored so a color present only in one photograph is not invented elsewhere.
  const changes = [];
  const sourceBands = st && st.background && st.background.bands, targetBands = want.background.bands;
  if (sourceBands && targetBands) for (const band of BANDS) {
    const have = sourceBands[band], target = targetBands[band];
    if (!have || !target || have.weight < 0.012 || target.weight < 0.012) continue;
    const hue = clamp(hueDiff(target.hue, have.hue) * move / 30 * 100, -45, 45);
    const sat = clamp((target.chroma - have.chroma) / Math.max(5, have.chroma) * 100 * move, -35, 35);
    const lum = clamp((target.lum - have.lum) / 18 * 100 * move, -25, 25);
    if (Math.abs(hue) >= 1 || Math.abs(sat) >= 1 || Math.abs(lum) >= 1) {
      local.background[`hue_${band}`] = Math.round(hue);
      local.background[`sat_${band}`] = Math.round(sat);
      local.background[`lum_${band}`] = Math.round(lum);
      changes.push(band);
    }
  }
  working = { ...working, local };
  const after = refit(working);
  const r1 = (v) => Math.round(v * 10) / 10;
  const rel = (s) => ({ sep: r1(s.sep), dA: r1(s.dA), dB: r1(s.dB), chroma: Math.round(Math.exp(s.logC) * 100) / 100 });
  return {
    params: working,
    regions: {
      ...relation.regions,
      after: rel(after),
      local,
      referenceStyle: { subjectCurve: !!curve, backgroundHslBands: changes },
    },
  };
}

