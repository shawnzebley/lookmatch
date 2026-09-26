// Stack all *_ba.jpg in a dir into one review sheet (reference at top).
import sharp from 'sharp'; import fs from 'fs';
const [dir, ref, out, w = 700] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('_ba.jpg')).sort();
const W = +w; const parts = [];
let y = 0;
const r = await sharp(ref).resize(null, 300).toBuffer(); parts.push({ input: r, left: 0, top: 0 }); y = 305;
for (const f of files) { const b = await sharp(`${dir}/${f}`).resize(W).toBuffer(); const m = await sharp(b).metadata(); parts.push({ input: b, left: 0, top: y }); y += m.height + 5; }
await sharp({ create: { width: W, height: y, channels: 3, background: '#fff' } }).composite(parts).jpeg({ quality: 80 }).toFile(out);
console.log(out, y);
