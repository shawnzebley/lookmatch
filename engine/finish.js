// Finishing touches: the part of a photographer's published look that a preset or a single reference
// photo doesn't carry. Every number is measured from the photographer's own published images
// (tools/measure_published.py; method and dates in _state/lookmatch.md). L* percentiles, Lab means
// by band (shadows L* < 30, highlights L* >= 70), mean chroma of colour images, centre-minus-edge L*.

import { processPixelSet } from './pipeline.js';
import { lm } from './solver.js';
import { counts } from './loss.js';

export const FINISH_PROFILES = {
  off: { name: 'Off' },
  // cvatik.com/portrait, 88 images, 2026-09-27
  cvatik: {
    name: 'Cvatik', who: 'Steve Gindler', source: 'cvatik.com/portrait', n: 88,
    p1: 3.2, p99: 87.6, chroma: 11.2, sh: [3.5, 6.5], hi: [-2.9, 0.6], vignette: -30, grain: 15, grainSize: 20,
  },
  // lightwitch.com portfolio galleries, 120 images, 2026-09-27: matte blacks (53/120 lift above L* 8)
  courtney: {
    name: 'Courtney Brooke', who: 'Courtney Brooke (Light Witch)', source: 'lightwitch.com', n: 120,
    p1: 6.4, p99: 85.8, chroma: 11.5, sh: [3.7, 4.5], hi: [-1.2, 3.5], vignette: -28, grain: 25, grainSize: 30, matte: true,
  },
  // xenichez.com/en/portfolio, 185 images (30 black and white), 2026-09-27: low-key, deepest blacks, strongest falloff
  xenie: {
    name: 'Xenie Zasetskaya', who: 'Xenie Zasetskaya', source: 'xenichez.com/en/portfolio', n: 185,
    p1: 1.6, p99: 86.1, chroma: 11.7, sh: [1.5, 3.6], hi: [1.3, 5.6], vignette: -40, grain: 10, grainSize: 15,
  },
  // Behance: 8 Playboy editorials + Fine Art set, 104 images (15 black and white), 2026-09-27: bright, colourful, soft blacks, no vignette
  anadias: {
    name: 'Ana Dias', who: 'Ana Dias', source: 'behance.net/anadiasphotography', n: 104,
    p1: 5.3, p99: 95.8, chroma: 20.4, sh: [7.6, 8.9], hi: [0.8, 4.7], vignette: 0, grain: 5, grainSize: 10, matte: true,
  },
  // 35photo.pro/dimm122 (@borisov_photo), 60 images (8 black and white), 2026-09-27: low-key, muted, warm shadows and highlights
  borisov: {
    name: 'Dmitry Borisov', who: 'Dmitry Borisov', source: '35photo.pro/dimm122', n: 60,
    p1: 3.0, p99: 86.8, chroma: 10.9, sh: [6.3, 6.2], hi: [0.1, 8.2], vignette: -28, grain: 12, grainSize: 20,
  },
  // petermckinnon.com portraits/people/places/lifestyle, 128 images (28 black and white), 2026-09-27
  mckinnon: {
    name: 'Peter McKinnon', who: 'Peter McKinnon', source: 'petermckinnon.com', n: 128,
    p1: 2.7, p99: 91.5, chroma: 15.4, sh: [1.0, 5.1], hi: [0.9, 6.5], vignette: -20, grain: 8, grainSize: 15,
  },
};

// How much of the gap to a profile's colour to close. The published averages include what was in
// front of the lens; closing all of it would paint every photo that photographer's locations.
const COLOR_MOVE = 0.35;

function sampleIdx(n) {
  const step = Math.max(1, Math.floor(n / 8000)), a = [];
  for (let i = 0; i < n; i += step) a.push(i);
  return Int32Array.from(a);
}

function stats(cur, idx) {
  const Ls = new Float32Array(idx.length);
  let shA = 0, shB = 0, shN = 0, hiA = 0, hiB = 0, hiN = 0, C = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], L = cur.L[i], a = cur.A[i], b = cur.B[i];
    Ls[k] = L; C += Math.hypot(a, b);
    if (L < 30) { shA += a; shB += b; shN++; } else if (L >= 70) { hiA += a; hiB += b; hiN++; }
  }
  Ls.sort();
  const q = (p) => Ls[Math.min(Ls.length - 1, Math.floor(p * (Ls.length - 1)))];
  const n = idx.length;
  return {
    p1: q(0.01), p99: q(0.99), chroma: C / n,
    sh: shN > n * 0.03 ? [shA / shN, shB / shN] : null,
    hi: hiN > n * 0.03 ? [hiA / hiN, hiB / hiN] : null,
  };
}

/**
 * Fit the finish sliders for one photo, after the preset or match has been solved.
 *  1. tone ends: finishBlacks / finishRolloff so the darkest and brightest 1% land on the profile
 *     (only toward it; a matte profile may lift the black point instead of crushing it)
 *  2. colour: shadow and highlight tints and overall intensity, a third of the way to the profile
 *  3. vignette and grain from the profile where the preset has none
 * The crush is backed off until the app's crushed-shadow check stays quiet.
 */
export function fitFinish(ps, params, profile, idx = null) {
  const out = { ...params, finishBlacks: 0, finishRolloff: 0, finishShA: 0, finishShB: 0, finishHiA: 0, finishHiB: 0, finishSat: 0 };
  if (!profile || profile.p1 == null) return out;
  const n = ps.n;
  idx = idx || sampleIdx(n);
  const cur = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const at = (p) => { processPixelSet(ps, p, idx, cur); return stats(cur, idx); };
  const st0 = at(out);
  const mono = st0.chroma < 3;

  // 1. tone ends. finishBlacks crushes; a matte profile whose black point sits above this photo's
  // gets there with the curve's black lift instead (fadeBlacks already exists for that).
  const needB = st0.p1 > profile.p1 + 0.5, needR = st0.p99 > profile.p99 + 0.5;
  if (needB || needR) {
    const fn = (x) => {
      const s = at({ ...out, finishBlacks: x[0], finishRolloff: x[1] });
      const c = counts(ps, cur, idx).crushed;
      return [needB ? s.p1 - profile.p1 : 0, needR ? s.p99 - profile.p99 : 0, Math.max(0, c - 0.25) * 40, x[0] / 400, x[1] / 400];
    };
    const r = lm(fn, [needB ? 40 : 0, needR ? 40 : 0], [0, 0], [needB ? 100 : 0, needR ? 100 : 0], { iters: 15 });
    out.finishBlacks = Math.round(r.x[0]); out.finishRolloff = Math.round(r.x[1]);
    const crushedAt = (v) => counts(ps, processPixelSet(ps, { ...out, finishBlacks: v })).crushed;
    if (out.finishBlacks > 0 && crushedAt(out.finishBlacks) > 0.3) {
      let lo = 0, hi = out.finishBlacks;
      for (let it = 0; it < 6; it++) { const m = (lo + hi) / 2; if (crushedAt(m) > 0.3) hi = m; else lo = m; }
      out.finishBlacks = Math.floor(lo);
    }
  } else if (profile.matte && st0.p1 < profile.p1 - 1) {
    // lift toward the matte black point, half-way
    out.fadeBlacks = Math.min(40, (params.fadeBlacks || 0) + (profile.p1 - st0.p1) * 0.5 * 4);
  }

  // 2. colour, a third of the way. Skipped for black and white photos.
  if (!mono) {
    const s1 = at(out);
    const tgt = {
      sh: s1.sh && profile.sh ? [s1.sh[0] + (profile.sh[0] - s1.sh[0]) * COLOR_MOVE, s1.sh[1] + (profile.sh[1] - s1.sh[1]) * COLOR_MOVE] : null,
      hi: s1.hi && profile.hi ? [s1.hi[0] + (profile.hi[0] - s1.hi[0]) * COLOR_MOVE, s1.hi[1] + (profile.hi[1] - s1.hi[1]) * COLOR_MOVE] : null,
      chroma: s1.chroma + (profile.chroma - s1.chroma) * COLOR_MOVE,
    };
    const clip0 = counts(ps, cur, idx).color; // cur holds s1's pixels
    const fn = (x) => {
      const s = at({ ...out, finishShA: x[0], finishShB: x[1], finishHiA: x[2], finishHiB: x[3], finishSat: x[4] });
      const clip = counts(ps, cur, idx).color;
      return [
        // no new clipped colour (the loss check warns at 1%)
        Math.max(0, clip - Math.max(clip0, 0.3)) * 25,
        tgt.sh && s.sh ? (s.sh[0] - tgt.sh[0]) / 0.8 : 0, tgt.sh && s.sh ? (s.sh[1] - tgt.sh[1]) / 0.8 : 0,
        tgt.hi && s.hi ? (s.hi[0] - tgt.hi[0]) / 0.8 : 0, tgt.hi && s.hi ? (s.hi[1] - tgt.hi[1]) / 0.8 : 0,
        (s.chroma - tgt.chroma) / 0.6,
        x[0] / 30, x[1] / 30, x[2] / 30, x[3] / 30, x[4] / 120,
      ];
    };
    const r = lm(fn, [0, 0, 0, 0, 0], [-8, -8, -8, -8, -40], [8, 8, 8, 8, 40], { iters: 12 });
    const rd = (v) => Math.round(v * 2) / 2;
    out.finishShA = rd(r.x[0]); out.finishShB = rd(r.x[1]); out.finishHiA = rd(r.x[2]); out.finishHiB = rd(r.x[3]); out.finishSat = Math.round(r.x[4]);
  }

  // 3. vignette and grain
  if (!params.vignette && profile.vignette) out.vignette = profile.vignette;
  if (!params.grain && profile.grain) { out.grain = profile.grain; out.grainSize = profile.grainSize ?? 20; }
  return out;
}
