#!/usr/bin/env node
// Fast solver-only ground-truth test (no PNGs, no Python). Same looks and pairs as tools/compare.mjs.
// For each look L and pair (R, T): reference = L(R), right answer = L(T). Scores mean CIEDE2000 vs L(T).
//
// Variants blank out one group of targets by copying the photo's own stats into the reference,
// which shows which targets help and which drag the reference's content colors into the edit.
//
// Usage: node tools/solver_eval.mjs <kodak dir> [--random] [--variants full,nobands] [--looks warm_film,...] [--json out.json]
import fs from 'fs';
import path from 'path';
import { loadPreview } from './load.mjs';
import { prepare, measure } from '../engine/measure.js';
import { solve } from '../engine/solver.js';
import { renderImage, defaultParams } from '../engine/pipeline.js';
import { SRGB8_TO_LIN, linToLab } from '../engine/color.js';
import { lossReport } from '../engine/loss.js';
import { processPixelSet } from '../engine/pipeline.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const variantArg = opt('--variants', 'full');
const lookArg = opt('--looks', '');
const jsonOut = opt('--json', '');
const random = flag('--random');
const dir = args[0];

const P = (o) => ({ ...defaultParams(), ...o });
export const LOOKS = {
  warm_film: { params: P({ temp: 25, tint: 5, contrast: -20, fadeBlacks: 25, saturation: -15, highlightHue: 45, highlightSat: 15 }) },
  teal_orange: { params: P({ contrast: 25, shadowHue: 200, shadowSat: 25, highlightHue: 35, highlightSat: 20, sat_orange: 15, sat_green: -30, hue_blue: -10 }) },
  moody_cool: { params: P({ exposure: -0.4, temp: -20, highlights: -40, shadows: -20, saturation: -30, contrast: 15 }) },
  bright_airy: { params: P({ exposure: 0.5, shadows: 40, contrast: -25, vibrance: 20, temp: 8, whites: 20 }) },
  cross_process: { fn: (r, g, b) => [Math.pow(r, 0.8), 0.04 + 0.96 * Math.pow(g, 1.08), 0.16 + 0.68 * b] },
  bleach_bypass: {
    fn: (r, g, b) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const s = (v) => { const x = 0.5 * v + 0.5 * y; return x + 0.6 * x * (1 - x) * (2 * x - 1); };
      return [s(r), s(g), s(b)];
    },
  },
};
function applyLook(look, img) {
  if (look.params) return renderImage(img, look.params);
  const ch = img.channels, out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += ch) {
    const v = look.fn(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round(v[c] * 255)));
    if (ch === 4) out[i + 3] = 255;
  }
  return { ...img, data: out };
}

// CIEDE2000, mean over pixels (every 2nd pixel)
function toLab(img) {
  const n = img.width * img.height, ch = img.channels, out = new Float32Array(n * 3), t = [0, 0, 0];
  for (let i = 0, j = 0; i < n; i++, j += ch) { linToLab(SRGB8_TO_LIN[img.data[j]], SRGB8_TO_LIN[img.data[j + 1]], SRGB8_TO_LIN[img.data[j + 2]], t); out[i * 3] = t[0]; out[i * 3 + 1] = t[1]; out[i * 3 + 2] = t[2]; }
  return out;
}
const R2D = 180 / Math.PI, D2R = Math.PI / 180;
function de2000(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  let h1p = Math.atan2(b1, a1p) * R2D; if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) * R2D; if (h2p < 0) h2p += 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0; if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * D2R);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p; if (C1p * C2p) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * D2R) + 0.24 * Math.cos(2 * hbp * D2R) + 0.32 * Math.cos((3 * hbp + 6) * D2R) - 0.2 * Math.cos((4 * hbp - 63) * D2R);
  const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lbp - 50) ** 2 / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dth * D2R) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
function meanDE(x, gtLab) {
  const a = toLab(x); let s = 0, c = 0;
  for (let i = 0; i < a.length; i += 6) { s += de2000(a[i], a[i + 1], a[i + 2], gtLab[i], gtLab[i + 1], gtLab[i + 2]); c++; }
  return s / c;
}

// blank a target group by giving the reference the photo's own stats for it
const ONE = { 1: 1, 5: 1, 10: 1, 25: 1, 50: 1, 75: 1, 90: 1, 95: 1, 99: 1 };
const ZERO = { 1: 0, 5: 0, 10: 0, 25: 0, 50: 1, 75: 0, 90: 0, 95: 0, 99: 0 };
const ENDS2 = { 1: 1, 5: 1, 10: 0.6, 25: 0.3, 50: 1, 75: 0.3, 90: 0.6, 95: 1, 99: 1 };
const ENDS0 = { 1: 1, 5: 0.5, 10: 0.2, 25: 0, 50: 1, 75: 0, 90: 0.2, 95: 0.5, 99: 1 };
// variants that change solver options instead of targets
const OPTS = {
  copyshape: { toneShape: ONE }, ownshape: { toneShape: ZERO }, ends2: { toneShape: ENDS2 }, ends0: { toneShape: ENDS0 },
  pull25: { brightnessPull: 0.25 }, old: { toneShape: ONE, zoneMove: 1, bandMove: 1 }, z50: { zoneMove: 0.5 }, z70: { zoneMove: 0.7 }, b50: { bandMove: 0.5 }, b0: { bandMove: 0 }, pull75: { brightnessPull: 0.75 },
};
const VARIANTS = {
  full: (o, r) => r,
  nobands: (o, r) => ({ ...r, bands: o.bands }),
  nozones: (o, r) => ({ ...r, zones: o.zones }),
  nochroma: (o, r) => ({ ...r, color: o.color }),
  nowb: (o, r) => ({ ...r, wb: { ...r, ...o.wb } }),
  notone: (o, r) => ({ ...r, tone: o.tone }),
  toneonly: (o, r) => ({ ...o, tone: r.tone }),
  tonewb: (o, r) => ({ ...o, tone: r.tone, wb: r.wb }),
};

const SIMILAR = [['09', '10'], ['10', '09'], ['19', '21'], ['21', '19'], ['06', '16'], ['16', '11'], ['04', '15'], ['15', '04'], ['01', '24'], ['24', '08'], ['13', '14'], ['12', '06']];
let pairs = SIMILAR.map(([a, b]) => [`${a}.png`, `${b}.png`]);
if (random) {
  const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  pairs = [];
  while (pairs.length < 12) { const a = files[Math.floor(rnd() * files.length)], b = files[Math.floor(rnd() * files.length)]; if (a !== b && !pairs.some(([x, y]) => x === a && y === b)) pairs.push([a, b]); }
}
const variants = variantArg.split(',');
const looks = lookArg ? lookArg.split(',') : Object.keys(LOOKS);

const cache = {};
const load = async (f) => (cache[f] ||= await loadPreview(path.join(dir, f)));
const res = {}; // look -> variant -> [dE]
const flags = {};
const orig = {};
for (const ln of looks) {
  res[ln] = Object.fromEntries(variants.map((v) => [v, []])); orig[ln] = []; flags[ln] = Object.fromEntries(variants.map((v) => [v, 0]));
  for (const [rf, tf] of pairs) {
    const R = await load(rf), Tm = await load(tf);
    const refImg = applyLook(LOOKS[ln], R), gt = applyLook(LOOKS[ln], Tm);
    const gtLab = toLab(gt);
    orig[ln].push(meanDE(Tm, gtLab));
    const ps = prepare(Tm), o = measure(ps), rs = measure(prepare(refImg));
    for (const v of variants) {
      const [base, ...extra] = v.split('+');
      const refV = (VARIANTS[base] || VARIANTS.full)(o, rs);
      const vo = Object.assign({ strength: 1 }, OPTS[base] || {}, ...extra.map((e) => OPTS[e] || {}));
      const refV2 = extra.reduce((r, e) => (VARIANTS[e] ? VARIANTS[e](o, r) : r), refV);
      const { params } = solve(ps, o, refV2, vo);
      res[ln][v].push(meanDE(renderImage(Tm, params), gtLab));
      const loss = lossReport(ps, processPixelSet(ps, params), params);
      if (loss.issues.some((i) => i.level === 'bad')) flags[ln][v]++;
    }
    process.stderr.write('.');
  }
}
process.stderr.write('\n');
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pad = (s, n = 10) => String(s).padStart(n);
console.log('look'.padEnd(15) + pad('orig') + variants.map((v) => pad(v)).join(''));
for (const ln of [...looks, 'ALL']) {
  const ls = ln === 'ALL' ? looks : [ln];
  const o = mean(ls.flatMap((l) => orig[l]));
  console.log(ln.padEnd(15) + pad(o.toFixed(2)) + variants.map((v) => pad(mean(ls.flatMap((l) => res[l][v])).toFixed(2))).join(''));
}
console.log('bad damage flags: ' + variants.map((v) => `${v} ${looks.reduce((s, l) => s + flags[l][v], 0)}`).join(', '));
console.log('beats untouched: ' + variants.map((v) => `${v} ${looks.reduce((s, l) => s + res[l][v].filter((d, i) => d < orig[l][i]).length, 0)}/${looks.length * pairs.length}`).join(', '));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ looks, variants, pairs, orig, res, flags }));
