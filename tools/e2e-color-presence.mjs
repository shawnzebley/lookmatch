// Exercise the browser worker and exported pixels, not just transfer coefficients.
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const url = process.argv[2] || 'http://127.0.0.1:8765';
const output = 'scratch/color-presence';
await fs.mkdir(output, { recursive: true });
const width = 120, height = 120;
const source = Buffer.alloc(width * height * 3);
const reference = Buffer.alloc(width * height * 3);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = (y * width + x) * 3;
  const green = x >= 30 && x < 90 && y >= 20 && y < 100;
  const gray = Math.round(60 + y);
  source.set(green ? [20, 110, 70] : [gray, gray, gray], offset);
  reference.set([235, 235, 235], offset);
}
await sharp(source, { raw: { width, height, channels: 3 } }).png().toFile(`${output}/source.png`);
await sharp(reference, { raw: { width, height, channels: 3 } }).png().toFile(`${output}/reference.png`);
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.setInputFiles('#pickRef', `${output}/reference.png`);
  await page.waitForSelector('#npSave:not([disabled])', { timeout: 90000 });
  await page.fill('#npName', 'Neutral reference color test');
  await page.click('#npSave');
  await page.waitForSelector('#npSave', { state: 'detached' });
  await page.setInputFiles('#pickPhotos', `${output}/source.png`);
  await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'done', null, { timeout: 120000 });
  const exported = await page.evaluate(async () => {
    const { S, pool } = window.__lm, photo = S.photos[0];
    const result = await pool.call(photo.worker, 'export', { id: photo.id, params: photo.params, quality: 95 });
    return { params: photo.params, bytes: [...new Uint8Array(await result.jpeg.arrayBuffer())] };
  });
  await fs.writeFile(`${output}/match.jpg`, Uint8Array.from(exported.bytes));
  const { data, info } = await sharp(`${output}/match.jpg`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const start = ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * info.channels;
  const rgb = [...data.subarray(start, start + 3)];
  const saturation = (Math.max(...rgb) - Math.min(...rgb)) / Math.max(...rgb);
  await fs.writeFile(`${output}/report.json`, JSON.stringify({ rgb, saturation, errors, params: exported.params }, null, 2));
  assert.ok(rgb[1] > rgb[0] * 1.2 && rgb[1] > rgb[2] * 1.1, `Green must remain green after export: ${rgb}`);
  assert.ok(saturation > 0.25, `Missing reference green must not bleach the source: saturation ${saturation}`);
  assert.ok(Math.max(...rgb) < 170, `Neutral reference must not turn dark green into mint/white: ${rgb}`);
  assert.deepEqual(errors, []);
  const report = { rgb, saturation, errors, params: exported.params };
  await fs.writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  const panels = [];
  for (const [index, file] of ['source.png', 'reference.png', 'match.jpg'].entries()) {
    panels.push({ input: await sharp(`${output}/${file}`).resize(240, 240).toBuffer(), left: index * 240, top: 0 });
  }
  await sharp({ create: { width: 720, height: 240, channels: 3, background: 'white' } })
    .composite(panels).png().toFile(`${output}/comparison.png`);
  console.log(JSON.stringify({ rgb, saturation, errors }));
} finally { await browser.close(); }
