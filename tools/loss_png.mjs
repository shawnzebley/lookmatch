#!/usr/bin/env node
// Runs LookMatch's damage checks (engine/loss.js) on finished images, for methods that don't go through
// the slider pipeline (e.g. outside models run by tools/run_models.py).
// Usage: node tools/loss_png.mjs scratch/cmp neuralpreset deeppreset
import fs from 'fs';
import sharp from 'sharp';
import { prepare } from '../engine/measure.js';
import { lossReport } from '../engine/loss.js';
import { defaultParams } from '../engine/pipeline.js';
import { SRGB8_TO_LIN, linToLab } from '../engine/color.js';

const [dir, ...methods] = process.argv.slice(2);
const runs = JSON.parse(fs.readFileSync(`${dir}/runs.json`, 'utf8'));
const raw = async (f) => { const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, channels: 3, data }; };
for (const r of runs.rows) {
  const base = `${dir}/${r.id}`;
  const orig = await raw(`${base}__orig.png`);
  const ps = prepare(orig);
  for (const m of methods) {
    const img = await raw(`${base}__${m}.png`);
    const n = ps.n, cur = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
    const lab = [0, 0, 0];
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const R = SRGB8_TO_LIN[img.data[j]], G = SRGB8_TO_LIN[img.data[j + 1]], B = SRGB8_TO_LIN[img.data[j + 2]];
      cur.lr[i] = R; cur.lg[i] = G; cur.lb[i] = B; linToLab(R, G, B, lab); cur.L[i] = lab[0]; cur.A[i] = lab[1]; cur.B[i] = lab[2];
    }
    const loss = lossReport(ps, cur, defaultParams());
    r.methods[m] = { ...(r.methods[m] || {}), ms: (runs.model_seconds_cpu?.[m] ?? 0) * 1000, loss: loss.values, issues: loss.issues.map((i) => `${i.level}:${i.kind}`) };
  }
}
fs.writeFileSync(`${dir}/runs.json`, JSON.stringify(runs, null, 1));
console.log('loss checks added for', methods.join(', '));
