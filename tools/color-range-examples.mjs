// Browser-rendered examples and regression checks for the picked HSL range.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { defaultParams } from '../engine/pipeline.js';
import { rgbToHsl } from '../engine/color-range.js';
import { referenceTransferStats, fitReferenceTransfer } from '../engine/reference-transfer.js';
import { srgbToLinear } from '../engine/color.js';

const output = 'scratch/color-range-examples', url = process.argv[2] || 'http://127.0.0.1:8765';
await fs.mkdir(output, { recursive: true });
const colors = [[20, 110, 70], [25, 115, 115], [220, 170, 100], [195, 140, 110], [35, 85, 180], [145, 145, 145]];
const width = 360, height = 240, pixels = Buffer.alloc(width * height * 3);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  pixels.set(colors[Math.floor(x / 60)], (y * width + x) * 3);
}
await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(`${output}/source.png`);
await sharp({ create: { width, height, channels: 3, background: { r: 25, g: 128, b: 80 } } }).png().toFile(`${output}/supported-reference.png`);
const green = colors[0].map(v => v / 255);
const selection = { ...rgbToHsl(green), hueWidth: 18, satWidth: 20, lightWidth: 20, softness: 0.35, region: 'all' };
function ps(rgb) {
  const n = 400, lin = rgb.map(srgbToLinear);
  return { n, lr: new Float32Array(n).fill(lin[0]), lg: new Float32Array(n).fill(lin[1]), lb: new Float32Array(n).fill(lin[2]) };
}
const sourceStats = referenceTransferStats(ps(green));
const point = { L: 40, a: -30, b: 15, selection, hue: 0, sat: 35, lum: 0, range: 50 };
const cases = [
  { id: 'manual', title: 'Manual: saturation +35, green range only', params: { ...defaultParams(), points: [point] } },
  { id: 'absent', title: 'White reference: no green support, unchanged', reference: [235, 235, 235], params: { ...defaultParams(), referenceColorRange: selection,
    referenceTransfer: fitReferenceTransfer(sourceStats, referenceTransferStats(ps([235, 235, 235].map(v => v / 255))), { preserveColors: true }) } },
  { id: 'supported', title: 'Green reference: selected green matches, others stay', reference: [25, 128, 80], params: { ...defaultParams(), referenceColorRange: selection,
    referenceTransfer: fitReferenceTransfer(sourceStats, referenceTransferStats(ps([25, 128, 80].map(v => v / 255))), { preserveColors: true }) } },
];
const browser = await chromium.launch({ channel: 'chrome' });
const report = { selection, examples: [], errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => localStorage.setItem('lm_look', JSON.stringify({ kind: 'none' })));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url);
  await page.setInputFiles('#pickPhotos', `${output}/source.png`);
  await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'done', null, { timeout: 90000 });
  for (const example of cases) {
    const bytes = await page.evaluate(async params => {
      const { S, pool } = window.__lm, photo = S.photos[0];
      const result = await pool.call(photo.worker, 'export', { id: photo.id, params, quality: 100 });
      return [...new Uint8Array(await result.jpeg.arrayBuffer())];
    }, example.params);
    await fs.writeFile(`${output}/${example.id}.jpg`, Uint8Array.from(bytes));
    const decoded = await sharp(`${output}/${example.id}.jpg`).removeAlpha().raw().toBuffer();
    const centers = colors.map((_, i) => [...decoded.subarray((120 * width + i * 60 + 30) * 3, (120 * width + i * 60 + 30) * 3 + 3)]);
    for (let i = 1; i < colors.length; i++) centers[i].forEach((v, c) => assert.ok(Math.abs(v - colors[i][c]) <= 3, `${example.id}: outside color ${i} changed`));
    if (example.id === 'absent') centers[0].forEach((v, c) => assert.ok(Math.abs(v - colors[0][c]) <= 3));
    else assert.ok(Math.max(...centers[0].map((v, c) => Math.abs(v - colors[0][c]))) > 8, `${example.id}: selected green should change`);
    report.examples.push({ id: example.id, sourceRGB: colors, exportedRGB: centers });
  }
  // Pick through the actual mobile editor, adjust sliders and exercise the range checkbox.
  await page.evaluate(params => {
    const photo = window.__lm.S.photos[0];
    photo.params = params;
    window.__lm.openDetail(photo);
  }, cases[2].params);
  await page.waitForFunction(() => window.__lm.D()?.edit && !window.__lm.D()?.busy);
  await page.locator('#ptabs [data-p=color]').click();
  await page.locator('#ptPick').click();
  const canvas = page.locator('#cv');
  // Canvas id is resolved from the editor's rendered canvas, not a test-only picker API.
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error('Editor canvas is unavailable');
  await canvas.click({ position: { x: canvasBox.width / 12, y: canvasBox.height / 2 } });
  await page.waitForFunction(() => window.__lm.D()?.p.params.points?.length === 1);
  const actualSelection = await page.evaluate(() => window.__lm.D().p.params.points[0].selection);
  assert.ok(Math.abs(actualSelection.h - selection.h) < 1 && Math.abs(actualSelection.s - selection.s) < 1, 'Picker must sample original green');
  await page.locator('#ptReferenceRange').check();
  for (const [key, value] of [['hueWidth', 18], ['satWidth', 20], ['lightWidth', 20], ['sat', 35]]) {
    const input = page.locator(`#ptSl .sl[data-k="${key}"] input[type=number]`);
    await input.fill(String(value));
    await input.dispatchEvent('change');
  }
  const persisted = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lm.D().p.params)));
  assert.equal(persisted.referenceColorRange.h, actualSelection.h);
  assert.equal(persisted.referenceColorRange.hueWidth, 18);
  assert.equal(persisted.points[0].sat, 35);
  await page.screenshot({ path: `${output}/picker-mobile.png` });
  await page.locator('#ptabs [data-p=look]').click();
  await page.locator('#dSeg [data-k=preset]').click();
  const downloading = page.waitForEvent('download');
  await page.locator('#saveRecipe').click();
  const download = await downloading;
  await download.saveAs(`${output}/picked-range.lookmatch.json`);
  const saved = JSON.parse(await fs.readFile(`${output}/picked-range.lookmatch.json`, 'utf8'));
  assert.deepEqual(saved.params.referenceColorRange, persisted.referenceColorRange);
  await page.locator('#ptabs [data-p=color]').click();
  await page.locator('#ptDel').click();
  assert.equal(await page.evaluate(() => window.__lm.D().p.params.referenceColorRange), undefined);
  await page.locator('#ptabs [data-p=look]').click();
  await page.setInputFiles('#recipeFile', `${output}/picked-range.lookmatch.json`);
  await page.waitForFunction(() => window.__lm.D()?.p.params.points?.length === 1 && window.__lm.D()?.p.params.referenceColorRange?.hueWidth === 18);
  report.recipeRoundtrip = true;
  await page.setInputFiles('#pickRef', `${output}/supported-reference.png`);
  await page.waitForSelector('#npSave:not([disabled])', { timeout: 90000 });
  await page.fill('#npName', 'Picked green rematch test');
  await page.locator('#npSave').click();
  await page.waitForSelector('#npSave', { state: 'detached' });
  await page.waitForFunction(() => window.__lm.D()?.p.status === 'done' && !window.__lm.D()?.busy);
  await page.evaluate(() => {
    const p = window.__lm.D().p;
    p.params.points.unshift({ auto: true, L: 50, a: 0, b: 0, hue: 0, sat: 0, lum: 0 });
    p.params.referenceColorRange.pointIndex = 1;
  });
  await page.locator('#reMatch').click();
  await page.waitForFunction(() => window.__lm.D()?.p.status === 'done' && !window.__lm.D()?.busy && window.__lm.D()?.p.params.points?.length === 1);
  const rematched = await page.evaluate(() => window.__lm.D().p.params);
  assert.equal(rematched.referenceColorRange.pointIndex, 0);
  assert.equal(rematched.referenceColorRange.hueWidth, 18);
  assert.equal(rematched.points[0].sat, 35);
  report.rematchPreservedRange = true;
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await fs.writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}

const panels = [], canvasWidth = 1120, rowHeight = 330;
for (let index = 0; index < cases.length; index++) {
  const example = cases[index], top = index * rowHeight;
  const svg = `<svg width="1120" height="330"><rect width="1120" height="330" fill="#15191e"/><g fill="#f0f3f5" font-family="Arial" font-size="19"><text x="16" y="28">${example.title}</text><text x="16" y="61">Source</text><text x="392" y="61">${example.reference ? 'Reference' : 'Picked range: hue ±18°, sat ±20, light ±20'}</text><text x="768" y="61">Exported result</text></g></svg>`;
  panels.push({ input: Buffer.from(svg), left: 0, top });
  panels.push({ input: await sharp(`${output}/source.png`).png().toBuffer(), left: 16, top: top + 76 });
  if (example.reference) panels.push({ input: await sharp({ create: { width, height, channels: 3, background: { r: example.reference[0], g: example.reference[1], b: example.reference[2] } } }).png().toBuffer(), left: 392, top: top + 76 });
  panels.push({ input: await sharp(`${output}/${example.id}.jpg`).png().toBuffer(), left: 768, top: top + 76 });
}
await sharp({ create: { width: canvasWidth + 24, height: rowHeight * cases.length, channels: 3, background: '#15191e' } }).composite(panels).png().toFile(`${output}/examples.png`);
console.log(JSON.stringify(report));
