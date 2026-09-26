// Checks the blotch/banding detector: renders a good edit and two deliberately bad ones,
// prints the in-app loss report for each, and writes PNGs for tools/flip_eval.py.
import fs from 'fs';
import sharp from 'sharp';
import { loadPreview, readFaces, readScene } from './load.mjs';
import { prepare, measure } from '../engine/measure.js';
import { solve } from '../engine/solver.js';
import { processPixelSet, renderImage } from '../engine/pipeline.js';
import { lossReport } from '../engine/loss.js';
const [refPath, f, outDir = 'scratch/art'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const ref = measure(prepare(await loadPreview(refPath), { faces: readFaces(refPath) }));
const ps = prepare(await loadPreview(f), { faces: readFaces(f) });
const res = solve(ps, measure(ps), ref, { scene: await readScene(f) });
const good = res.params;
const variants = {
  good,
  blotchy: { ...good, hue_red: 60, hue_orange: -60, sat_orange: 60, sat_yellow: -60 },
  banded: { ...good, contrast: 100, highlights: -100, shadows: -100, whites: 100, blacks: 100, fadeBlacks: 0, fadeWhites: 0 },
};
const big = await loadPreview(f, 1000);
await sharp(Buffer.from(big.data), { raw: { width: big.width, height: big.height, channels: big.channels } }).png().toFile(`${outDir}/orig.png`);
for (const [k, p] of Object.entries(variants)) {
  const L = lossReport(ps, processPixelSet(ps, p), p);
  console.log(k.padEnd(8), `blotchy ${L.values.uneven.toFixed(2)}%  banding slope ${L.values.banding.toFixed(2)}  lost detail ${L.values.flattened.toFixed(2)}%`, '|', L.issues.map((i) => `${i.level}:${i.label}`).join(', ') || 'no warnings');
  const r = renderImage(big, p);
  await sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: r.channels } }).png().toFile(`${outDir}/${k}.png`);
}
fs.writeFileSync(`${outDir}/faces.json`, JSON.stringify(readFaces(f) || []));
