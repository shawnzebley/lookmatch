// Finishing touches: "if this photographer edited this photo, what would they do?"
//
// Each profile carries numbers measured from the photographer's own published images
// (tools/measure_published.py for the medians below; tools/style_records.py for per-image rows in
// style-data.js). For a photo, the published images with the most similar scenes are found
// (engine/style.js) and their finished black point, white roll-off, shadow / midtone / highlight
// colour, colour intensity and vignette become this photo's targets. The colour lands on the
// colour-grading wheels, so what they'd do is visible and editable.

import { processPixelSet } from './pipeline.js';
import { lm } from './solver.js';
import { counts } from './loss.js';
import { wheelHueToAB, abToWheelHue } from './color.js';
import { signature, nearestTargets } from './style.js';
import { STYLE_DATA } from './style-data.js';

export const FINISH_PROFILES = {
  off: { name: 'Off' },
  // cvatik.com/portrait, 88 images, 2026-09-27
  cvatik: {
    name: 'Cvatik', who: 'Steve Gindler', source: 'cvatik.com/portrait', n: 88,
    p1: 3.2, p99: 87.6, chroma: 11.2, sh: [3.5, 6.5], hi: [-2.9, 0.6], vignette: -30, grain: 15, grainSize: 20,
  },
  // www.lightwitch.com, 10 galleries (latest, portrait clients, couples, fashion, musicians, commercial, personal,
  // (per-image rows in style-data.js re-measured 2026-09-27 from 833 images, with subject/background)
  // humanless, strange fusions, archive), 659 images, 2026-09-27: matte blacks (269/659 lift above L* 8), dim whites
  courtney: {
    name: 'Courtney Brooke', who: 'Courtney Brooke (Light Witch)', source: 'lightwitch.com', n: 659,
    p1: 6.8, p99: 76.6, chroma: 12.2, sh: [3.5, 6.2], hi: [0.2, 1.9], vignette: -28, grain: 25, grainSize: 30, matte: true,
  },
  // xenichez.com/en/portfolio, 185 images (30 black and white), 2026-09-27: low-key, deepest blacks, strongest falloff
  xenie: {
    name: 'Xenie Zasetskaya', who: 'Xenie Zasetskaya', source: 'xenichez.com/en/portfolio', n: 185,
    p1: 1.6, p99: 86.1, chroma: 11.7, sh: [1.5, 3.6], hi: [1.3, 5.6], vignette: -40, grain: 10, grainSize: 15,
  },
  // Behance: 8 Playboy editorials, Fine Art and print-collection sets, 125 images (16 black and white), 2026-09-27
  // (read in a signed-in Chrome): bright, colourful, soft blacks, no vignette
  anadias: {
    name: 'Ana Dias', who: 'Ana Dias', source: 'behance.net/anadiasphotography', n: 125,
    p1: 4.3, p99: 96.2, chroma: 18.5, sh: [6.6, 7.4], hi: [0.6, 4.0], vignette: 0, grain: 5, grainSize: 10, matte: true,
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
for (const [k, p] of Object.entries(FINISH_PROFILES)) p.data = STYLE_DATA[k] || null;

// How much of the colour gap to close. Published images include what was in front of the lens;
// with similar-scene neighbours less of the gap is scenery, so more of it can be closed.
const MOVE_NEAREST = 0.5, MOVE_MEDIAN = 0.35;
const WHEEL_MAX = 20; // most a wheel may move, in wheel units (20 = 6 Lab)
const ZN = ['shadow', 'midtone', 'highlight'];
const G = 30; // Lab units at 100% wheel saturation (pipeline.js)

function sampleIdx(n) {
  const step = Math.max(1, Math.floor(n / 8000)), a = [];
  for (let i = 0; i < n; i += step) a.push(i);
  return Int32Array.from(a);
}

function stats(cur, idx, skinMask) {
  const Ls = new Float32Array(idx.length);
  const z = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let C = 0, sa = 0, sb = 0, sn = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], L = cur.L[i], a = cur.A[i], b = cur.B[i];
    Ls[k] = L; C += Math.hypot(a, b);
    const zi = L < 30 ? 0 : L < 70 ? 1 : 2;
    z[zi][0] += a; z[zi][1] += b; z[zi][2]++;
    if (skinMask && skinMask[i] && L > 35) { sa += a; sb += b; sn++; }
  }
  Ls.sort();
  const q = (p) => Ls[Math.min(Ls.length - 1, Math.floor(p * (Ls.length - 1)))];
  const n = idx.length;
  const band = (zi) => (z[zi][2] > n * 0.03 ? [z[zi][0] / z[zi][2], z[zi][1] / z[zi][2]] : null);
  return {
    p1: q(0.01), p99: q(0.99), chroma: C / n, sh: band(0), mid: band(1), hi: band(2),
    skin: sn > 30 ? [sa / sn, sb / sn] : null,
  };
}

const wheelXY = (p, z) => { const s = p[`${z}Sat`] || 0; const [a, b] = wheelHueToAB(p[`${z}Hue`] || 0); return [a * s, b * s]; };
const hueDeg = (ab) => { let h = (Math.atan2(ab[1], ab[0]) * 180) / Math.PI; return h < 0 ? h + 360 : h; };
const wrap = (d) => ((d + 540) % 360) - 180;

/** Per-photo targets: nearest published scenes when the profile has per-image data, else its medians. */
export function styleTargets(ps, profile, mono = false) {
  if (profile.data) {
    const sig = signature(ps.L, ps.A, ps.B, ps.width, ps.height);
    const t = nearestTargets(profile.data, sig, { color: !mono });
    if (t) {
      const pair = (a, b) => (t[a] != null && t[b] != null ? [t[a], t[b]] : null);
      return {
        basis: 'nearest', k: t.k, n: t.n, p1: t.p1, p99: t.p99, chroma: t.chroma,
        sh: pair('shA', 'shB'), mid: pair('midA', 'midB'), hi: pair('hiA', 'hiB'),
        vig: t.vig, vigMedian: t.vigMedian, spreadSh: t.spreadSh, spreadHi: t.spreadHi, sig,
      };
    }
  }
  return { basis: 'median', n: profile.n, p1: profile.p1, p99: profile.p99, chroma: profile.chroma, sh: profile.sh, mid: null, hi: profile.hi, vig: null };
}

/**
 * Fit the finish for one photo, after the preset or match has been solved.
 *  1. tone ends: finishBlacks / finishRolloff so the darkest and brightest 1% land on the target
 *     (only toward it; a matte photographer lifts the black point instead of crushing it)
 *  2. colour: the three colour-grading wheels (added to whatever the match put there) and overall
 *     intensity move part of the way to the target shadow / midtone / highlight colour, with skin
 *     hue held and no new clipped colour
 *  3. vignette and grain, scaled by how much falloff the similar published photos show
 * Returns { params, style } — style is what the page shows as "what they'd do".
 */
export function fitFinish(ps, params, profile, idx = null, { strength = 1 } = {}) {
  const out = { ...params, finishBlacks: 0, finishRolloff: 0, finishShA: 0, finishShB: 0, finishHiA: 0, finishHiB: 0, finishSat: 0 };
  if (!profile || profile.p1 == null) return { params: out, style: null };
  const n = ps.n;
  idx = idx || sampleIdx(n);
  const skinMask = ps.masks && ps.masks.skin;
  const cur = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const at = (p) => { processPixelSet(ps, p, idx, cur); return stats(cur, idx, skinMask); };
  const st0 = at(out);
  const mono = st0.chroma < 3;
  const T = styleTargets(ps, profile, mono);
  const move = (T.basis === 'nearest' ? MOVE_NEAREST : MOVE_MEDIAN) * strength;
  const toneK = Math.min(1, strength);
  // tone-end targets part-way when the style is dialled down
  T.p1 = st0.p1 + (T.p1 - st0.p1) * toneK; T.p99 = st0.p99 + (T.p99 - st0.p99) * toneK;

  // 1. tone ends
  const needB = st0.p1 > T.p1 + 0.5, needR = st0.p99 > T.p99 + 0.5;
  if (needB || needR) {
    const fn = (x) => {
      const s = at({ ...out, finishBlacks: x[0], finishRolloff: x[1] });
      const c = counts(ps, cur, idx).crushed;
      return [needB ? s.p1 - T.p1 : 0, needR ? s.p99 - T.p99 : 0, Math.max(0, c - 0.25) * 40, x[0] / 400, x[1] / 400];
    };
    const r = lm(fn, [needB ? 40 : 0, needR ? 40 : 0], [0, 0], [needB ? 100 : 0, needR ? 100 : 0], { iters: 15 });
    out.finishBlacks = Math.round(r.x[0]); out.finishRolloff = Math.round(r.x[1]);
    const crushedAt = (v) => counts(ps, processPixelSet(ps, { ...out, finishBlacks: v })).crushed;
    if (out.finishBlacks > 0 && crushedAt(out.finishBlacks) > 0.3) {
      let lo = 0, hi = out.finishBlacks;
      for (let it = 0; it < 6; it++) { const m = (lo + hi) / 2; if (crushedAt(m) > 0.3) hi = m; else lo = m; }
      out.finishBlacks = Math.floor(lo);
    }
  } else if ((profile.matte || T.p1 > 5) && st0.p1 < T.p1 - 1) {
    // lift toward the matte black point, half-way
    out.fadeBlacks = Math.min(40, (params.fadeBlacks || 0) + (T.p1 - st0.p1) * 0.5 * 4);
  }

  // 2. colour on the wheels. Skipped for black and white photos.
  const s1 = at(out);
  const base = ZN.map((z) => wheelXY(out, z));
  let wheels = null;
  if (!mono) {
    // trust the neighbours less where they disagree about a zone's colour
    const trust = (spread) => (spread == null ? 1 : Math.max(0.4, Math.min(1, 6 / (spread + 3))));
    const aim = (have, want, tr = 1) => (have && want ? [have[0] + (want[0] - have[0]) * move * tr, have[1] + (want[1] - have[1]) * move * tr] : null);
    const tgt = {
      sh: aim(s1.sh, T.sh, trust(T.spreadSh)), mid: aim(s1.mid, T.mid), hi: aim(s1.hi, T.hi, trust(T.spreadHi)),
      chroma: s1.chroma + (T.chroma - s1.chroma) * move,
    };
    const clip0 = counts(ps, cur, idx).color; // cur holds s1's pixels
    const skin0 = s1.skin;
    const withWheels = (x) => ({ ...out, _gradeAB: base.map(([a, b], z) => [a + x[2 * z], b + x[2 * z + 1]]), finishSat: x[6] });
    const fn = (x) => {
      const s = at(withWheels(x));
      const clip = counts(ps, cur, idx).color;
      const r = [Math.max(0, clip - Math.max(clip0, 0.3)) * 25];
      for (const [k, sc] of [['sh', 0.8], ['mid', 1.0], ['hi', 0.8]]) {
        r.push(tgt[k] && s[k] ? (s[k][0] - tgt[k][0]) / sc : 0, tgt[k] && s[k] ? (s[k][1] - tgt[k][1]) / sc : 0);
      }
      r.push((s.chroma - tgt.chroma) / 0.6);
      // skin: keep its hue within 4 degrees and don't drain it
      if (skin0 && s.skin) {
        const dh = wrap(hueDeg(s.skin) - hueDeg(skin0));
        r.push(Math.max(0, Math.abs(dh) - 4) / 1.5, Math.max(0, 0.85 * Math.hypot(...skin0) - Math.hypot(...s.skin)) / 1.5);
      }
      for (let j = 0; j < 6; j++) r.push(x[j] / 40);
      r.push(x[6] / 120);
      return r;
    };
    // a zone with no target (too few pixels there, or no data) keeps its wheel where the match left it
    const L = WHEEL_MAX, lo = [], hi = [];
    for (const k of ['sh', 'mid', 'hi']) { const on = tgt[k] ? L : 0; lo.push(-on, -on); hi.push(on, on); }
    lo.push(-40); hi.push(40);
    const r = lm(fn, [0, 0, 0, 0, 0, 0, 0], lo, hi, { iters: 14 });
    out.finishSat = Math.round(r.x[6]);
    wheels = {};
    ZN.forEach((z, zi) => {
      const [a, b] = [base[zi][0] + r.x[2 * zi], base[zi][1] + r.x[2 * zi + 1]];
      const sat = Math.min(100, Math.hypot(a, b));
      out[`${z}Sat`] = Math.round(sat * 10) / 10;
      out[`${z}Hue`] = sat > 0.05 ? abToWheelHue(a, b) : (out[`${z}Hue`] || 0);
      const d = [r.x[2 * zi], r.x[2 * zi + 1]];
      wheels[z] = { from: { hue: params[`${z}Hue`] || 0, sat: params[`${z}Sat`] || 0 }, to: { hue: out[`${z}Hue`], sat: out[`${z}Sat`] }, move: { hue: Math.hypot(...d) > 0.05 ? abToWheelHue(d[0], d[1]) : 0, amount: Math.round(Math.hypot(...d) * 10) / 10 } };
    });
  }

  // 3. vignette and grain
  if (!params.vignette && profile.vignette) {
    let v = profile.vignette * Math.min(1.5, strength);
    if (T.vig != null && T.vigMedian != null && Math.abs(T.vigMedian) > 2) v = Math.round(v * Math.max(0.3, Math.min(1.6, T.vig / T.vigMedian)));
    out.vignette = v;
  }
  if (!params.grain && profile.grain && strength > 0) { out.grain = Math.round(profile.grain * Math.min(1.5, strength)); out.grainSize = profile.grainSize ?? 20; }

  const s2 = at(out);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const pr = (v) => (v ? [r1(v[0]), r1(v[1])] : null);
  const style = {
    name: profile.name, who: profile.who, source: profile.source,
    basis: T.basis, k: T.k || null, n: T.n,
    target: { p1: r1(T.p1), p99: r1(T.p99), chroma: r1(T.chroma), sh: pr(T.sh), mid: pr(T.mid), hi: pr(T.hi) },
    before: { p1: r1(s1.p1), p99: r1(s1.p99), chroma: r1(s1.chroma), sh: pr(s1.sh), mid: pr(s1.mid), hi: pr(s1.hi) },
    after: { p1: r1(s2.p1), p99: r1(s2.p99), chroma: r1(s2.chroma), sh: pr(s2.sh), mid: pr(s2.mid), hi: pr(s2.hi) },
    start: { p1: r1(st0.p1), p99: r1(st0.p99) },
    wheels, mono,
    blacks: out.finishBlacks, rolloff: out.finishRolloff, fade: (out.fadeBlacks || 0) - (params.fadeBlacks || 0),
    sat: out.finishSat, vignette: out.vignette || 0, grain: out.grain || 0,
  };
  delete out._gradeAB;
  return { params: out, style };
}
