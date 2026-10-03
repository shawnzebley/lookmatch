// Real worker, rendered-preview and encoded-JPEG acceptance regression.
// Usage: node tools/e2e-reference-acceptance.mjs URL PORTRAIT OUTPUT_DIR
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const [url, portrait, output = 'scratch/acceptance'] = process.argv.slice(2);
if (!portrait) throw new Error('Provide URL and a portrait containing skin detail.');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('lm_look', JSON.stringify({ kind: 'photographer', key: 'legacy' })));
  await page.goto(url);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lm_look'))), { kind: 'none' });
  assert.equal(await page.locator('#styleSeg [data-k=photographer]').count(), 0);
  await page.evaluate(() => {
    for (const entry of window.__lm.pool.workers) entry.addEventListener('message', event => {
      if (event.data.ok === false) console.error(event.data.stack);
    });
  });
  page.on('console', message => { if (message.type() === 'error') console.log(message.text()); });
  await page.setInputFiles('#pickRef', portrait);
  await page.waitForSelector('#npSave:not([disabled])', { timeout: 90000 });
  await page.fill('#npName', 'Acceptance self-reference');
  await page.click('#npSave');
  await page.waitForSelector('#npSave', { state: 'detached' });
  await page.setInputFiles('#pickPhotos', portrait);
  await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'done' && window.__lm.D()?.edit, null, { timeout: 90000 });
  await page.locator('#ptabs [data-p=look]').click();
  await page.click('#workflowNeedham');
  await page.waitForSelector('h2:text-is("Needham workflow")');
  assert.equal(await page.locator('a[href="https://gerardneedham.com/products/analog-curve-collection"]').count(), 1);
  await page.locator('[data-close]').click();
  const results = await page.evaluate(async () => {
    const { S, pool } = window.__lm, p = S.photos[0], reference = S.presets.find(r => r.name === 'Acceptance self-reference').stats;
    const args = { id: p.id, refStats: reference, strength: 1 };
    const original = await pool.call(p.worker, 'measureParams', { ...args, params: p.params });
    const badParams = { ...p.params, exposure: 3, whites: 100 };
    const bad = await pool.call(p.worker, 'measureParams', { ...args, params: badParams });
    const finish = await pool.call(p.worker, 'measureParams', { ...args, params: { ...p.params, vignette: 100, halation: 60 } });
    const missing = await pool.call(p.worker, 'measureParams', { ...args, refStats: { regions: reference.regions }, params: p.params });
    const exported = await pool.call(p.worker, 'export', { ...args, params: badParams, quality: 92 });
    const safeExport = await pool.call(p.worker, 'export', { ...args, params: p.params, quality: 92 });
    // Keep a reviewable real JPEG and the measured evidence.
    const bytes = [...new Uint8Array(await safeExport.jpeg.arrayBuffer())];
    return { original: original.acceptance, bad: bad.acceptance, finish: finish.acceptance, missing: missing.acceptance,
      exported: exported.acceptance, safeExport: safeExport.acceptance, bytes, dimensions: [safeExport.width, safeExport.height] };
  });
  await fs.writeFile(path.join(output, 'diagnostics.json'), JSON.stringify({ ...results, bytes: undefined }, null, 2));
  assert.equal(results.original.status, 'accepted', 'Self-reference must pass with usable skin/region evidence');
  assert.equal(results.bad.status, 'rejected', 'Overexposed skin must fail actual rendered checks');
  assert.equal(results.exported.status, 'rejected', 'Encoded overexposed JPEG must fail');
  assert.equal(results.exported.scope, 'export-sample');
  assert.equal(results.missing.status, 'unverified');
  assert.notDeepEqual(results.finish.checks, results.original.checks, 'Finishing effects must affect rendered checks');
  assert.equal(results.safeExport.status, 'accepted');
  await page.$eval('.sl[data-k=exposure] input[type=number]', el => { el.value = '3'; el.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => window.__lm.S.photos[0]?.acceptance?.status === 'rejected', null, { timeout: 30000 });
  await page.locator('#ptabs [data-p=look]').click();
  await page.waitForFunction(() => document.body.textContent.includes('Reference match needs review'));
  await page.screenshot({ path: path.join(output, 'needs-review.png') });
  // Hold a completed measurement while a real mask change triggers a newer one.
  // Returning a fake old success must not overwrite the newer certificate.
  await page.evaluate(() => {
    const pool = window.__lm.pool, original = pool.call.bind(pool);
    const race = window.__acceptanceRace = { original, held: false, once: false, release: null };
    pool.call = (...args) => {
      if (args[1] !== 'measureParams' || race.once) return original(...args);
      race.once = true;
      return original(...args).then(result => new Promise(resolve => {
        race.held = true;
        race.release = () => resolve({ ...result, acceptance: { ...result.acceptance, status: 'accepted', accepted: true, scope: 'stale-test-certificate' } });
      }));
    };
  });
  try {
    await page.$eval('.sl[data-k=exposure] input[type=number]', el => { el.value = '2.9'; el.dispatchEvent(new Event('change')); });
    await page.waitForFunction(() => window.__acceptanceRace.held);
    const maskVersion = await page.evaluate(() => window.__lm.S.photos[0].mask.ver);
    await page.locator('#ptabs [data-p=subject]').click();
    await page.$eval('#mAuto', el => { el.checked = !el.checked; el.dispatchEvent(new Event('change')); });
    await page.waitForFunction(version => window.__lm.S.photos[0].mask.ver !== version && window.__lm.S.photos[0].acceptance != null, maskVersion);
    const status = await page.evaluate(async () => {
      window.__acceptanceRace.release();
      await new Promise(resolve => setTimeout(resolve, 100));
      return window.__lm.S.photos[0].acceptance.scope;
    });
    assert.notEqual(status, 'stale-test-certificate', 'Old measurement must not overwrite checks after a mask change');
    results.staleMaskCertificateIgnored = true;
  } finally {
    await page.evaluate(() => { window.__lm.pool.call = window.__acceptanceRace.original; window.__acceptanceRace.release?.(); });
  }
  await fs.writeFile(path.join(output, 'self-reference-export.jpg'), Uint8Array.from(results.bytes));
  delete results.bytes;
  assert.deepEqual(errors, [], 'No browser exceptions');
  await fs.writeFile(path.join(output, 'acceptance-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ statuses: Object.fromEntries(['original', 'bad', 'finish', 'missing', 'exported', 'safeExport'].map(k => [k, results[k].status])), staleMaskCertificateIgnored: results.staleMaskCertificateIgnored, dimensions: results.dimensions, browserErrors: errors }));
} finally { await browser.close(); }
