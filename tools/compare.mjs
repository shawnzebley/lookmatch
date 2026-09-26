#!/usr/bin/env node
// Ground-truth accuracy test: slider solver vs color transfer.
//
// For each look L and pair (R, T): the reference is L(R) and the right answer is L(T), i.e. what the same edit
// does to the other photo. Each method sees only L(R) and T, and we score how close it lands to L(T).
// Four looks are made with LookMatch's own sliders (the solver can express them exactly); two are made
// outside the slider pipeline (the solver can only approximate them), so neither method gets a home game.
//
// Usage: node tools/compare.mjs testdata/kodak --out scratch/compare [--pairs 12]
// Then:  python3 tools/compare_score.py scratch/compare
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadPreview } from './load.mjs';
import { prepare, measure } from '../engine/measure.js';
import { solve } from '../engine/solver.js';
import { renderImage, defaultParams, processPixelSet } from '../engine/pipeline.js';
import { lossReport } from '../engine/loss.js';
import { transferStats, fitTransfer, transferLUT, transferPixelSet, transferSlope } from '../engine/transfer.js';
import { applyLUT } from '../engine/pipeline.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const outDir = opt('--out', 'scratch/compare');
const nPairs = +opt('--pairs', 12);
const dir = args[0];
fs.mkdirSync(outDir, { recursive: true });

const P = (o) => ({ ...defaultParams(), ...o });
const LOOKS = {
  warm_film: { params: P({ temp: 25, tint: 5, contrast: -20, fadeBlacks: 25, saturation: -15, highlightHue: 45, highlightSat: 15 }) },
  teal_orange: { params: P({ contrast: 25, shadowHue: 200, shadowSat: 25, highlightHue: 35, highlightSat: 20, sat_orange: 15, sat_green: -30, hue_blue: -10 }) },
  moody_cool: { params: P({ exposure: -0.4, temp: -20, highlights: -40, shadows: -20, saturation: -30, contrast: 15 }) },
  bright_airy: { params: P({ exposure: 0.5, shadows: 40, contrast: -25, vibrance: 20, temp: 8, whites: 20 }) },
  // outside the slider set: per-channel curves and a luminance blend
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
const save = (img, f) => sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } }).png().toFile(f);

// fixed pseudo-random pairs (ref != target)
const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
// --similar: hand-picked Kodak pairs shot on the same kind of scene (how a preset is normally used)
const SIMILAR = [['09', '10'], ['10', '09'], ['19', '21'], ['21', '19'], ['06', '16'], ['16', '11'], ['04', '15'], ['15', '04'], ['01', '24'], ['24', '08'], ['13', '14'], ['12', '06']];
const similar = args.includes('--similar') && args.splice(args.indexOf('--similar'), 1);
const pairs = similar ? SIMILAR.map(([a, b]) => [`${a}.png`, `${b}.png`]) : [];
while (!similar && pairs.length < nPairs) {
  const a = files[Math.floor(rnd() * files.length)], b = files[Math.floor(rnd() * files.length)];
  if (a !== b && !pairs.some(([x, y]) => x === a && y === b)) pairs.push([a, b]);
}

const METHODS = ['solver', 'hm-mkl-hm', 'mkl', 'hm'];
const cache = {};
const load = async (f) => (cache[f] ||= await loadPreview(path.join(dir, f)));
const rows = [];
for (const [lookName, look] of Object.entries(LOOKS)) {
  for (const [rf, tf] of pairs) {
    const R = await load(rf), T = await load(tf);
    const refImg = applyLook(look, R), gt = applyLook(look, T);
    const id = `${lookName}__${rf.replace(/\.\w+$/, '')}_to_${tf.replace(/\.\w+$/, '')}`;
    await save(refImg, `${outDir}/${id}__ref.png`);
    await save(gt, `${outDir}/${id}__gt.png`);
    await save(T, `${outDir}/${id}__orig.png`);
    const ps = prepare(T);
    const row = { id, look: lookName, ref: rf, target: tf, methods: {} };
    for (const m of METHODS) {
      const t0 = performance.now();
      let out, cur, params;
      if (m === 'solver') {
        const refStats = measure(prepare(refImg));
        const res = solve(ps, measure(ps), refStats, { strength: 1 });
        params = res.params;
        out = renderImage(T, params);
        cur = processPixelSet(ps, params);
      } else {
        const fn = fitTransfer(T, transferStats(refImg), { method: m });
        const lut = transferLUT(fn);
        out = { ...T, data: new Uint8Array(T.data.length) };
        applyLUT(lut, T.data, out.data, T.width * T.height, T.channels, T.channels);
        cur = transferPixelSet(ps, fn);
        params = { ...defaultParams() };
        row.methods[m] = { slope: transferSlope(fn) };
      }
      const ms = performance.now() - t0;
      const loss = lossReport(ps, cur, params);
      if (m !== 'solver') loss.values.banding = row.methods[m].slope;
      row.methods[m] = { ...row.methods[m], ms, loss: loss.values, issues: loss.issues.map((i) => `${i.level}:${i.kind}`) };
      await save(out, `${outDir}/${id}__${m}.png`);
    }
    rows.push(row);
    process.stderr.write('.');
  }
}
process.stderr.write('\n');
fs.writeFileSync(`${outDir}/runs.json`, JSON.stringify({ methods: METHODS, rows }, null, 1));
console.log(`${rows.length} cases written to ${outDir}`);
