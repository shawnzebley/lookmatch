// Subject vs background. After the whole-photo edit is solved, the style decides how the subject should
// sit against its background: how much brighter or darker, warmer or cooler, more or less colourful.
// Those three relations are fitted with a few local sliders per region (exposure, temp, tint, saturation)
// while the photo as a whole stays where the whole-photo edit put it.

import { processPixelSet } from './pipeline.js';
import { regionStats, regionUsable } from './measure.js';
import { lm } from './solver.js';
import { counts } from './loss.js';

// Share of the gap closed. Much of how a subject sits against its background in any one photo is the
// light it was shot in, not the edit, so only part of the difference is copied, and no more than
// STEP of each relation per photo (a photographer's subject mask is a nudge, not a relight).
export const REGION_MOVE = 0.4;
const STEP = { sep: 6, dA: 3, dB: 3, logC: 0.22 };
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
export function regionTargets(now, want, move = REGION_MOVE) {
  if (!now || !want) return null;
  // Pulling the subject back into its background (darker, or duller than it) is the rarer edit, and
  // usually the scene's own light rather than a choice, so those moves go a third / half as far.
  const t = (k) => {
    if (want[k] == null || Number.isNaN(want[k])) return now[k];
    let d = (want[k] - now[k]) * move;
    if (d < 0 && k === 'sep') d *= 0.35;
    if (d < 0 && k === 'logC') d *= 0.5;
    return now[k] + Math.max(-STEP[k], Math.min(STEP[k], d));
  };
  return { sep: t('sep'), dA: t('dA'), dB: t('dB'), logC: t('logC'), move, want };
}

/**
 * Fit local amounts for subject and background. params: the solved whole-photo edit (may already carry
 * params.local, which is replaced). want: { sep, dA, dB, logC }. Returns { params, regions } or null
 * when the photo has no usable subject/background split.
 */
export function fitRegions(ps, params, want, { move = REGION_MOVE, idx = null } = {}) {
  if (!ps.subject || !want) return null;
  idx = idx || sampleIdx(ps.n);
  const n = ps.n;
  const cur = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const base = { ...params };
  delete base.local;
  const st0 = regionStats(ps, processPixelSet(ps, base, idx, cur), idx);
  if (!regionUsable(st0)) return null;
  const T = regionTargets(st0, want, move);
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
    const s = regionStats(ps, processPixelSet(ps, p, idx, cur), idx);
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
  const st1 = regionStats(ps, processPixelSet(ps, out, idx, cur), idx);
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

