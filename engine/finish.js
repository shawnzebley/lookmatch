// Finish profiles: the part of a photographer's published look that the Lightroom preset doesn't carry.
// Numbers are measured from the photographer's own published images (see _state/lookmatch.md log).
import { measure } from './measure.js';
import { processPixelSet } from './pipeline.js';
import { lm } from './solver.js';
import { counts } from './loss.js';

export const FINISH_PROFILES = {
  off: { name: 'Off' },
  // cvatik.com/portrait, 88 images, measured 2026-09-27: median p1 L* 3, p99 L* 88,
  // center 13.6 L* brighter than edges (part lighting, part vignette), fine grain.
  cvatik: { name: 'Cvatik published', p1: 3, p99: 88, vignette: -30, grain: 15, grainSize: 20 },
};

/**
 * Fit the global finish sliders (finishBlacks, finishRolloff) so this photo's darkest 1% and
 * brightest 1% land where the profile says, then add the profile's vignette/grain where the preset
 * has none of its own. Only ever pushes toward the target: a photo already darker than the target
 * black point, or already under the highlight cap, is left alone.
 */
export function fitFinish(ps, params, profile, idx = null) {
  if (!profile || profile.p1 == null) return { ...params };
  const n = ps.n;
  if (!idx) { const step = Math.max(1, Math.floor(n / 8000)); const a = []; for (let i = 0; i < n; i += step) a.push(i); idx = Int32Array.from(a); }
  const cur = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const base = { ...params, finishBlacks: 0, finishRolloff: 0 };
  processPixelSet(ps, base, idx, cur);
  const st0 = measure(ps, cur, idx);
  const needB = st0.tone.pct[1] > profile.p1 + 0.5, needR = st0.tone.pct[99] > profile.p99 + 0.5;
  let fb = 0, fr = 0;
  if (needB || needR) {
    const fn = (x) => {
      processPixelSet(ps, { ...base, finishBlacks: x[0], finishRolloff: x[1] }, idx, cur);
      const st = measure(ps, cur, idx);
      // don't crush more than the loss check allows (0.5% new pure black = warning)
      return [needB ? (st.tone.pct[1] - profile.p1) : 0, needR ? (st.tone.pct[99] - profile.p99) : 0,
        Math.max(0, counts(ps, cur, idx).crushed - 0.25) * 40, x[0] / 400, x[1] / 400];
    };
    const r = lm(fn, [needB ? 40 : 0, needR ? 40 : 0], [0, 0], [needB ? 100 : 0, needR ? 100 : 0], { iters: 15 });
    fb = Math.round(r.x[0]); fr = Math.round(r.x[1]);
    // check on every pixel, not the sample; back the crush off until the loss check stays quiet
    const crushedAt = (v) => counts(ps, processPixelSet(ps, { ...base, finishBlacks: v, finishRolloff: fr })).crushed;
    if (fb > 0 && crushedAt(fb) > 0.3) {
      let lo = 0, hi = fb;
      for (let it = 0; it < 6; it++) { const m = (lo + hi) / 2; if (crushedAt(m) > 0.3) hi = m; else lo = m; }
      fb = Math.floor(lo);
    }
  }
  const out = { ...params, finishBlacks: fb, finishRolloff: fr };
  if (!params.vignette && profile.vignette) out.vignette = profile.vignette;
  if (!params.grain && profile.grain) { out.grain = profile.grain; out.grainSize = profile.grainSize ?? 20; }
  return out;
}
