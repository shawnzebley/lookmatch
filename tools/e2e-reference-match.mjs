// Actual source/reference pair and full JPEG export. Reports fit quality without hiding review failures.
// Usage: node tools/e2e-reference-match.mjs URL SOURCE REFERENCE OUTPUT_DIR
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const [url, source, reference, output = 'scratch/reference-pair'] = process.argv.slice(2);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.setInputFiles('#pickRef', reference);
  await page.waitForSelector('#npSave:not([disabled])', { timeout: 90000 });
  await page.fill('#npName', 'Reference pair');
  await page.click('#npSave');
  await page.waitForSelector('#npSave', { state: 'detached' });
  await page.setInputFiles('#pickPhotos', source);
  await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'done', null, { timeout: 120000 });
  const result = await page.evaluate(async () => {
    const { S, pool } = window.__lm, photo = S.photos[0], target = S.presets.find(p => p.name === 'Reference pair').stats;
    const exported = await pool.call(photo.worker, 'export', { id: photo.id, params: photo.params, refStats: target, strength: 1, quality: 92, lightroom: true });
    return { before: photo.before, after: photo.after, target, params: photo.params, acceptance: photo.acceptance,
      exportAcceptance: exported.acceptance, lightroomWarning: exported.lightroomWarning, hasXmp: !!exported.xmp, dimensions: [exported.width, exported.height], bytes: [...new Uint8Array(await exported.jpeg.arrayBuffer())] };
  });
  await fs.writeFile(path.join(output, 'match.jpg'), Uint8Array.from(result.bytes));
  delete result.bytes;
  await page.screenshot({ path: path.join(output, 'match.png') });
  // Auto Adjust must execute the complete Needham workflow even over a LAB reference baseline.
  await page.waitForFunction(() => window.__lm.D()?.edit);
  const beforeAuto = await page.evaluate(() => JSON.stringify(window.__lm.S.photos[0].params));
  if (await page.locator('#panelToggle').getAttribute('aria-expanded') === 'false') await page.click('#panelToggle');
  await page.click('#autoAdjust');
  await page.waitForFunction(() => !document.querySelector('#autoAdjust').disabled, null, { timeout: 120000 });
  const auto = await page.evaluate(() => structuredClone(window.__lm.S.photos[0].params));
  assert.ok(auto.contrast < 0, 'Needham reduces basic contrast');
  for (const channel of ['curve', 'curveR', 'curveG', 'curveB']) assert.ok(auto[channel]?.length >= 2, `Needham fits ${channel}`);
  assert.equal(auto.referenceMethod, 'lab-distribution');
  assert.deepEqual(auto.referenceTransfer, result.params.referenceTransfer);
  assert.deepEqual(auto.local, result.params.local, 'Auto Adjust retains per-region LAB baseline');
  assert.notEqual(JSON.stringify(auto), beforeAuto, 'Button applies workflow settings');
  await page.click('#undo');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__lm.S.photos[0].params)), beforeAuto, 'Undo restores all settings');
  result.needham = { applied: true, undo: true, contrast: auto.contrast, exposure: auto.exposure };
  assert.deepEqual(errors, []);
  assert.ok(result.params.skinMatch?.people?.length, 'Real pair must produce person-specific skin correction');
  assert.equal(result.params.referenceMethod, 'lab-distribution');
  assert.equal(result.hasXmp, false, 'Do not export a sidecar that cannot reproduce the mapping');
  assert.ok(result.lightroomWarning);
  await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ preview: result.acceptance.status, export: result.exportAcceptance.status, dimensions: result.dimensions, errors }));
} finally { await browser.close(); }
