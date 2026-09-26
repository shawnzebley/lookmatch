// Renders a grid showing each slider at -max / 0 / +max on one image, and checks the identity LUT.
import sharp from 'sharp';
import { loadPreview } from './load.mjs';
import { renderImage, defaultParams, SLIDERS } from '../engine/pipeline.js';
const f = process.argv[2], out = process.argv[3] || 'sliders.jpg';
const img = await loadPreview(f, 240);
const id = renderImage(img, defaultParams());
let maxErr = 0, sumErr = 0;
for (let i = 0; i < img.data.length; i++) { const e = Math.abs(id.data[i] - img.data[i]); maxErr = Math.max(maxErr, e); sumErr += e; }
console.log(`identity LUT: max error ${maxErr} levels, mean ${(sumErr / img.data.length).toFixed(3)}`);
const keys = process.argv[4] ? process.argv[4].split(',') : ['temp','tint','exposure','contrast','highlights','shadows','whites','blacks','fadeBlacks','fadeWhites','saturation','vibrance','sat_orange','hue_blue','lum_blue','shadowSat'];
const tiles = [];
let row = 0;
for (const k of keys) {
  const s = SLIDERS.find((x) => x.key === k);
  const vals = s.ui[0] < 0 ? [s.ui[0], 0, s.ui[1]] : [0, s.ui[1] / 2, s.ui[1]];
  vals.forEach((v, c) => {
    const p = defaultParams(); p[k] = v;
    if (k === 'shadowSat') p.shadowHue = 200;
    const r = renderImage(img, p);
    tiles.push({ input: { raw: { width: r.width, height: r.height, channels: r.channels } , buf: r.data }, left: c * (img.width + 4), top: row * (img.height + 4), label: `${k}=${v}` });
  });
  row++;
}
const W = 3 * (img.width + 4), H = row * (img.height + 4);
const comps = await Promise.all(tiles.map(async (t) => ({ input: await sharp(Buffer.from(t.input.buf), { raw: t.input.raw }).png().toBuffer(), left: t.left, top: t.top })));
await sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } }).composite(comps).jpeg({ quality: 85 }).toFile(out);
console.log('wrote', out, keys.join(' '));
