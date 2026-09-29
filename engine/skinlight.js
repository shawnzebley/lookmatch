// Last word on skin lightness. The solver aims skin at the reference's, but whatever runs after it (subject /
// background split, photographer finish, Lightroom-preset looks) can still lift faces. This pass measures the
// finished edit and, when the lit side of the skin ended up brighter than allowed, pulls it back: subject
// exposure when there is a subject mask, else whole-photo exposure.

import { processPixelSet } from './pipeline.js';
import { measure } from './measure.js';
import { skinLightDelta, SKIN_L_TOL } from './solver.js';

// no reference skin to match (Lightroom presets, photographer finishes): faces may brighten this much
export const SKIN_L_FREE_UP = 3;
const MAX_PULL = 1.2; // most EV taken off

function sampleIdx(n, count = 12000) {
  const step = Math.max(1, Math.floor(n / count)), a = [];
  for (let i = 0; i < n; i += step) a.push(i);
  return Int32Array.from(a);
}

/**
 * o: measure(ps) of the original. ref: reference stats or null. Returns { params, skin } where skin says
 * what happened ({ before, after, target, pulled }), or { params } untouched when nothing was needed.
 */
export function guardSkinLight(ps, params, o, ref = null, strength = 1) {
  const { active, litDelta } = skinLightDelta(o, ref, strength);
  if (!active || o.skin.frac < 0.0004 || !(o.skin.litL > 0)) return { params };
  const target = o.skin.litL + (litDelta == null ? SKIN_L_FREE_UP : litDelta);
  const limit = target + SKIN_L_TOL;
  const idx = sampleIdx(ps.n);
  const cur = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  const litAt = (p) => { processPixelSet(ps, p, idx, cur); const st = measure(ps, cur, idx); return st.skin.frac > 0.0003 ? st.skin.litL : null; };
  const before = litAt(params);
  if (before == null || before <= limit) return { params };
  const useLocal = !!ps.subject;
  const make = (ev) => {
    if (!useLocal) return { ...params, exposure: (params.exposure || 0) - ev };
    const loc = params.local || {};
    return { ...params, local: { ...loc, subject: { ...(loc.subject || {}), exposure: ((loc.subject && loc.subject.exposure) || 0) - ev } } };
  };
  let lo = 0, hi = MAX_PULL;
  if (litAt(make(hi)) > limit) lo = hi; // can't reach it: take the full pull
  else for (let it = 0; it < 8; it++) { const m = (lo + hi) / 2; if (litAt(make(m)) > limit) lo = m; else hi = m; }
  const ev = Math.round(Math.min(MAX_PULL, hi) * 100) / 100;
  const out = make(ev);
  return { params: out, skin: { before, after: litAt(out), target, pulled: ev, where: useLocal ? 'subject' : 'photo' } };
}
