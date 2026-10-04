// Derive editable, adaptive looks from Cvatik's published same-scene demo pairs.
// These are measured approximations of the examples, not the commercial preset files.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prepare } from '../engine/measure.js';

const source = 'https://www.cvatik.com/demo';
const cache = 'scratch/cvatik';
await fs.mkdir(cache, { recursive: true });
await fs.mkdir('web/looks/cvatik', { recursive: true });
const html = await (await fetch(source)).text();
const urls = [...new Set([...html.matchAll(/<img\s+src="([^"]+)"/g)].map(m => m[1]))];
if (urls.length !== 24) throw new Error(`Expected 24 demo images, found ${urls.length}`);
const pairs = [];
for (let i = 0; i < 12; i++) {
  const id = `cvatik-${String(i + 1).padStart(2, '0')}`;
  const pair = { id, name: `Cvatik ${String(i + 1).padStart(2, '0')}`, source,
    beforeUrl: urls[i * 2], afterUrl: urls[i * 2 + 1], thumb: `looks/cvatik/${id}.jpg` };
  for (const side of ['before', 'after']) {
    const file = path.join(cache, `${id}-${side}.jpg`);
    try { await fs.access(file); } catch {
      const response = await fetch(pair[`${side}Url`] + '?format=1000w');
      if (!response.ok) throw new Error(`${id} ${side}: HTTP ${response.status}`);
      await fs.writeFile(file, new Uint8Array(await response.arrayBuffer()));
    }
    pair[`${side}File`] = file;
  }
  await sharp(pair.afterFile).resize({ width: 320, height: 480, fit: 'inside' }).jpeg({ quality: 82 }).toFile(`web/${pair.thumb}`);
  pairs.push(pair);
}
await fs.writeFile(path.join(cache, 'pairs.json'), JSON.stringify(pairs, null, 2));

// Small local contact sheet for checking pair order and target appearance.
const tiles = [];
for (let i = 0; i < pairs.length; i++) for (let j = 0; j < 2; j++) {
  const side = j ? 'after' : 'before', left = (i % 4) * 320 + j * 160, top = Math.floor(i / 4) * 260;
  tiles.push({ input: await sharp(pairs[i][`${side}File`]).resize(160, 235, { fit: 'contain', background: '#222' }).toBuffer(), left, top });
  tiles.push({ input: Buffer.from(`<svg width="160" height="25"><rect width="160" height="25" fill="#222"/><text x="5" y="18" fill="white" font-size="12">${pairs[i].name} ${side}</text></svg>`), left, top: top + 235 });
}
await sharp({ create: { width: 1280, height: 780, channels: 3, background: '#222' } }).composite(tiles).jpeg().toFile(path.join(cache, 'pairs-contact.jpg'));
if (process.argv.includes('--assets-only')) {
  console.log('Downloaded 12 before/after pairs and created target thumbnails.');
  process.exit(0);
}
const { buildAdaptiveLook } = await import('../engine/adaptive-look.js');
const profiles = [];
for (const pair of pairs) {
  const pixels = async file => {
    const { data, info } = await sharp(file).resize({ width: 512, height: 512, fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return prepare({ width: info.width, height: info.height, channels: 4, data });
  };
  const before = await pixels(pair.beforeFile), after = await pixels(pair.afterFile);
  if (before.width !== after.width || before.height !== after.height) throw new Error(`${pair.id}: pair dimensions differ`);
  // Use the original image's skin classification on both sides of the aligned pair.
  before.skinMask = Uint8Array.from(before.masks.skin, v => v ? 255 : 0);
  after.skinMask = before.skinMask;
  const profile = buildAdaptiveLook(before, after, pair);
  delete profile.beforeFile; delete profile.afterFile;
  profiles.push({ ...profile, beforeUrl: pair.beforeUrl, afterUrl: pair.afterUrl,
    derivation: 'Measured from a published before/after example; not an original Lightroom preset.' });
  console.log(`Measured ${pair.id}`);
}
await fs.writeFile('web/looks/cvatik.json', JSON.stringify(profiles, null, 2) + '\n');
console.log(`Built ${profiles.length} adaptive looks.`);
