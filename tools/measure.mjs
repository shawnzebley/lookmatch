#!/usr/bin/env node
// Usage: node tools/measure.mjs photo.jpg [more...]   prints the measured stats as JSON
import { loadPreview } from './load.mjs';
import { prepare, measure, roundStats } from '../engine/measure.js';
for (const f of process.argv.slice(2)) {
  const t0 = performance.now();
  const img = await loadPreview(f);
  const ps = prepare(img);
  const s = measure(ps);
  console.log(`== ${f}  (${img.width}x${img.height} preview, ${(performance.now() - t0).toFixed(0)} ms)`);
  console.log(JSON.stringify(roundStats(s, 2), null, 1).replace(/\n\s+/g, ' ').replace(/\{ "/g, '{"'));
}
