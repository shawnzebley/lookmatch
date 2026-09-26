#!/usr/bin/env node
// Usage: node tools/match.mjs ref.jpg photo1 photo2 ... [--strength 1] [--out dir] [--full]
// Prints before/after numbers per photo and writes before|after previews.
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadPreview, loadFull } from './load.mjs';
import { prepare, measure, PCTS } from '../engine/measure.js';
import { solve } from '../engine/solver.js';
import { renderImage, SLIDERS } from '../engine/pipeline.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const strength = +opt('--strength', 1);
const outDir = opt('--out', 'out');
const full = flag('--full');
const [refPath, ...photos] = args;
fs.mkdirSync(outDir, { recursive: true });

const ref = measure(prepare(await loadPreview(refPath)));
const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2);
const errTone = (s, T) => PCTS.reduce((a, p) => a + Math.abs(s.tone.pct[p] - T.tone.pct[p]), 0) / PCTS.length;
const errWB = (s, T) => Math.hypot(s.wb.a - T.wb.a, s.wb.b - T.wb.b);
const errZone = (s, T) => { const zs = Object.keys(T.zones); return zs.length ? zs.reduce((a, z) => a + Math.hypot(s.zones[z].a - T.zones[z].a, s.zones[z].b - T.zones[z].b), 0) / zs.length : 0; };
const errBand = (s, T) => { const ks = Object.keys(T.bands); if (!ks.length) return 0; return ks.reduce((a, b) => a + Math.abs(s.bands[b].chroma - T.bands[b].chroma), 0) / ks.length; };

const rows = [];
for (const f of photos) {
  const img = await loadPreview(f);
  const ps = prepare(img);
  const o = measure(ps);
  const res = solve(ps, o, ref, { strength });
  const { processPixelSet } = await import('../engine/pipeline.js');
  const a = measure(ps, processPixelSet(ps, res.params));
  const T = res.targets;
  const name = path.basename(f).replace(/\.[^.]+$/, '');
  rows.push({ name, o, a, T, params: res.params, ms: res.timings.total, guard: res.guardScale });
  // before | after preview
  const big = await loadPreview(f, 900);
  const after = renderImage(big, res.params);
  const b1 = await sharp(Buffer.from(big.data), { raw: { width: big.width, height: big.height, channels: big.channels } }).png().toBuffer();
  const b2 = await sharp(Buffer.from(after.data), { raw: { width: big.width, height: big.height, channels: big.channels } }).png().toBuffer();
  await sharp({ create: { width: big.width * 2 + 8, height: big.height, channels: 3, background: '#fff' } })
    .composite([{ input: b1, left: 0, top: 0 }, { input: b2, left: big.width + 8, top: 0 }]).jpeg({ quality: 88 }).toFile(`${outDir}/${name}_ba.jpg`);
  if (full) {
    const F = await loadFull(f);
    const t = performance.now();
    const R = renderImage(F, res.params);
    await sharp(Buffer.from(R.data), { raw: { width: F.width, height: F.height, channels: F.channels } }).jpeg({ quality: 92 }).toFile(`${outDir}/${name}_matched.jpg`);
    console.error(`${name}: full-res ${F.width}x${F.height} render ${(performance.now() - t).toFixed(0)} ms`);
  }
  fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify({ params: res.params, before: o, after: a, targets: T, timings: res.timings }, null, 1));
}

const hdr = ['photo', 'median L* b>a (ref)', 'tone err b>a', 'p1 / p99 after', 'neutral cast err b>a', 'zone color err b>a', 'band chroma err b>a', 'mean chroma b>a (ref)', 'new clip hi/lo %', 'skin hue b>a', 'skin spread b>a', 'lit skin hue/chroma b>a', 'solve ms'];
console.log(hdr.join(' | '));
for (const r of rows) {
  const { o, a, T } = r;
  console.log([
    r.name,
    `${f1(o.tone.pct[50])} > ${f1(a.tone.pct[50])} (${f1(ref.tone.pct[50])})`,
    `${f1(errTone(o, T))} > ${f1(errTone(a, T))}`,
    `${f1(a.tone.pct[1])} / ${f1(a.tone.pct[99])}`,
    `${f1(errWB(o, T))} > ${f1(errWB(a, T))}`,
    `${f1(errZone(o, T))} > ${f1(errZone(a, T))}`,
    `${f1(errBand(o, T))} > ${f1(errBand(a, T))}`,
    `${f1(o.color.meanChroma)} > ${f1(a.color.meanChroma)} (${f1(ref.color.meanChroma)})`,
    `${f2(Math.max(0, a.tone.clipHi - o.tone.clipHi) * 100)} / ${f2(Math.max(0, a.tone.clipLo - o.tone.clipLo) * 100)}`,
    o.skin.frac > 0.005 ? `${f1(o.skin.hue)} > ${f1(a.skin.hue)}` : 'n/a',
    o.skin.frac > 0.005 ? `${f1(o.skin.hueSpread)} > ${f1(a.skin.hueSpread)}` : 'n/a',
    o.skin.frac > 0.005 ? `${f1(o.skin.litHue)}/${f1(o.skin.litChroma)} > ${f1(a.skin.litHue)}/${f1(a.skin.litChroma)}` : 'n/a',
    r.ms.toFixed(0) + (r.guard < 1 ? ` (guard ${Math.round(r.guard * 100)}%)` : ''),
  ].join(' | '));
}
console.log('\nparams:');
for (const r of rows) {
  const nz = Object.entries(r.params).filter(([k, v]) => v && !(k.endsWith('Hue') && !r.params[k.replace('Hue', 'Sat')])).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : v}`);
  console.log(r.name + ': ' + nz.join(' '));
}
fs.writeFileSync(`${outDir}/summary.json`, JSON.stringify(rows.map((r) => ({ name: r.name, params: r.params, ms: r.ms })), null, 1));
