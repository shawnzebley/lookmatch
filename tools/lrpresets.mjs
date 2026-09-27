// Dump a folder of Lightroom presets to JSON: raw settings, mapped LookMatch params, and what's missing.
// usage: node tools/lrpresets.mjs <presetDir> <out.json>   (write into scratch/ — values stay out of git)
import fs from 'node:fs';
import path from 'node:path';
import { parsePreset, toParams, unsupported } from '../engine/lrpreset.js';

const [dir, outFile = 'scratch/presets.json'] = process.argv.slice(2);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== '__MACOSX') walk(f); }
    else if (/\.(lrtemplate|xmp)$/i.test(e.name)) files.push(f);
  }
})(dir);

const out = [];
const miss = {};
for (const f of files.sort()) {
  const { name, settings } = parsePreset(fs.readFileSync(f, 'utf8'), path.basename(f));
  const u = unsupported(settings);
  for (const k of u) miss[k.startsWith('profile') ? 'camera profile' : k] = (miss[k.startsWith('profile') ? 'camera profile' : k] || 0) + 1;
  out.push({ pack: path.basename(path.dirname(f)), name, params: toParams(settings), unsupported: u, settings });
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`${out.length} presets -> ${outFile}`);
console.log('presets using a feature LookMatch lacks:');
for (const [k, v] of Object.entries(miss).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
