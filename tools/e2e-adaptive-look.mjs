// Exercise all bundled adaptive looks, photo-specific solving, recipes, masks, and export.
// Usage: node tools/e2e-adaptive-look.mjs URL SOURCE_A SOURCE_B
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [url, sourceA, sourceB] = process.argv.slice(2);
if (!sourceB) throw new Error('Provide the app URL and two different source photos.');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, 'canShare', { value: () => false }));
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('Browser error:', e.message); });
  await page.goto(url);
  await fs.mkdir('scratch/adaptive-e2e', { recursive: true });
  await page.waitForSelector('.rcard');
  await page.screenshot({ path: 'scratch/adaptive-e2e/gallery.png', fullPage: true });
  await page.setInputFiles('#pickPhotos', [sourceA, sourceB]);
  await page.waitForFunction(() => window.__lm?.S?.photos?.length === 2, null, { timeout: 30000 });
  try { await page.waitForFunction(() => window.__lm.S.photos.every((p) => ['ready', 'done'].includes(p.status)), null, { timeout: 90000 }); }
  catch (error) { console.log(await page.evaluate(() => window.__lm.S.photos.map(p => ({ name: p.name, status: p.status, error: p.error })))); throw error; }
  const first = page.locator('.tile:not(.add)').first();
  await first.click();
  await page.locator('#ptabs [data-p=look]').click();
  await waitReadyPreview(page);
  const lookButtons = page.locator('#dPick button[data-l^="preset:adaptive:"]');
  assert.equal(await lookButtons.count(), 12, 'All twelve built-in looks should be selectable.');
  const waitSolved = () => page.waitForFunction(() => {
    const p = window.__lm.D()?.p;
    return p && p.status === 'done' && !window.__lm.D().busy && !window.__lm.D().again && window.__lm.D().edit;
  }, null, { timeout: 90000 });
  const snapshot = () => page.evaluate(() => {
    const d = window.__lm.D(), c = document.createElement('canvas');
    c.width = d.edit.width; c.height = d.edit.height;
    const ctx = c.getContext('2d'); ctx.drawImage(d.edit, 0, 0);
    let hash = 2166136261;
    for (const byte of ctx.getImageData(0, 0, c.width, c.height).data) hash = Math.imul(hash ^ byte, 16777619);
    return { hash, params: JSON.stringify(d.p.params), adaptive: d.p.adaptive };
  });
  const outputs = [];
  const identity = await snapshot();
  const count = process.argv.includes('--quick') ? 2 : await lookButtons.count();
  for (let i = 0; i < count; i++) {
    const button = lookButtons.nth(i);
    await button.click(); await waitSolved();
    const rendered = await snapshot();
    assert.equal(rendered.adaptive?.fitVersion, 3, 'Built-in look must use smooth per-photo fitting.');
    console.log(`Look ${i + 1}: ${rendered.adaptive?.id}, pixel hash ${rendered.hash}`);
    outputs.push(rendered.hash);
  }
  assert.equal(new Set(outputs).size, count, 'Selected looks must produce distinct rendered pixels.');

  const selected = lookButtons.first();
  await selected.click(); await waitSolved();
  const full = await snapshot();
  const amount = page.locator('#str');
  await amount.fill('0'); await amount.dispatchEvent('change'); await waitSolved();
  const zero = await snapshot();
  assert.equal(zero.hash, identity.hash, 'Amount zero should restore the untouched photo.');
  assert.notEqual(zero.params, full.params, 'Amount zero should remove the adaptive correction.');
  await amount.fill('100'); await amount.dispatchEvent('change'); await waitSolved();
  const protectedResult = await snapshot();
  const protect = page.locator('#skinProtection');
  assert.equal(await protect.count(), 1, 'Adaptive look should expose skin protection.');
  await protect.fill('0'); await protect.dispatchEvent('change'); await waitSolved();
  assert.notEqual((await snapshot()).params, protectedResult.params, 'Skin match amount should affect the solved edit.');
  await protect.fill('100'); await protect.dispatchEvent('change'); await waitSolved();

  await page.locator('#ptabs [data-p=subject]').click();
  await page.locator('#mAdd').click();
  const stage = await page.locator('#stage').boundingBox();
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.waitForFunction(() => window.__lm.D()?.p.mask?.picks > 0, null, { timeout: 60000 });
  await waitSolved();
  const savedMaskPicks = await page.evaluate(() => window.__lm.D().p.mask.picks);
  await page.locator('#ptabs [data-p=look]').click();

  const downloadPromise = page.waitForEvent('download');
  await page.click('#saveRecipe');
  const recipeDownload = await downloadPromise;
  const recipePath = await recipeDownload.path();
  const recipe = JSON.parse(await (await import('node:fs/promises')).readFile(recipePath, 'utf8'));
  await fs.writeFile('scratch/adaptive-e2e/recipe.json', JSON.stringify(recipe));
  assert.equal(recipe.version, 1);
  assert.ok(recipe.look?.id && recipe.params && recipe.geom !== undefined && recipe.sourceFingerprint);
  assert.ok(recipe.mask?.picks?.length);
  const expected = await snapshot();
  await amount.fill('35'); await amount.dispatchEvent('change'); await waitSolved();
  await page.locator('#ptabs [data-p=subject]').click();
  await page.click('#mUndo');
  await page.waitForFunction((n) => window.__lm.D().p.mask.picks === n - 1, savedMaskPicks, { timeout: 15000 });
  await waitSolved();
  await page.locator('#ptabs [data-p=look]').click();
  await page.click('#loadRecipe');
  await page.locator('#recipeFile').setInputFiles(recipePath);
  try { await page.waitForFunction((params) => JSON.stringify(window.__lm.D().p.params) === params, expected.params, { timeout: 15000 }); }
  catch (error) { console.log(await page.locator('body').innerText()); throw error; }
  assert.equal((await snapshot()).params, expected.params, 'Loading a recipe should restore parameters without solving.');
  assert.equal(await page.evaluate(() => window.__lm.D().p.mask.picks), savedMaskPicks, 'Recipe should restore editable mask taps.');
  await waitReadyPreview(page);
  assert.equal((await snapshot()).hash, expected.hash, 'Recipe should restore the rendered image');
  const invalid = { ...recipe, params: { ...recipe.params, exposure: 'invalid' } };
  await fs.writeFile('scratch/adaptive-e2e/invalid-recipe.json', JSON.stringify(invalid));
  await page.locator('#recipeFile').setInputFiles('scratch/adaptive-e2e/invalid-recipe.json');
  await page.waitForFunction(() => document.querySelector('#recipeFile')?.value === '');
  assert.equal((await snapshot()).params, expected.params, 'Invalid recipes must leave the current edit intact');

  // The existing subject editor and manual slider controls remain available.
  await page.locator('#ptabs [data-p=subject]').click();
  assert.ok(await page.locator('#regionCard').count());
  await page.locator('#ptabs [data-p=light]').click();
  assert.ok(await page.locator('#sliders input[type=range]').count());
  await page.locator('#sliders input[type=range]').first().focus();
  await page.keyboard.press('ArrowRight');

  // Compare adaptive corrections between two separately measured photos.
  await page.locator('#dBack').click();
  await page.locator('.tile:not(.add)').nth(1).click(); await page.locator('#ptabs [data-p=look]').click();
  const secondLook = page.locator('#dPick button[data-l^="preset:adaptive:"]').first();
  await secondLook.click(); await waitSolved();
  const second = await snapshot();
  assert.notEqual(second.params, expected.params, 'Different photos should receive their own adaptive parameters.');
  assert.ok(second.adaptive, 'The editor should report the per-photo adaptive fit.');

  await page.evaluate(() => { window.__lm.S.settings.dest = 'device'; });
  await page.screenshot({ path: 'scratch/adaptive-e2e/editor.png' });
  await page.click('#dExport');
  const exportLink = page.locator('#expActs a[download$="_lookmatch.jpg"]');
  try { await exportLink.waitFor({ timeout: 90000 }); }
  catch (error) { console.log(await page.locator('#expStatus').textContent()); throw error; }
  const [exported] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
  await exported.saveAs('scratch/adaptive-e2e/export.jpg');
  assert.match(exported.suggestedFilename(), /\.(jpe?g|png)$/i, 'Export should produce a rendered copy.');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  console.log(`Adaptive e2e passed: ${outputs.length} looks, photo-specific results, protection, recipe roundtrip, manual controls, export.`);
} finally { await browser.close(); }

async function waitReadyPreview(page) {
  await page.waitForFunction(() => {
    const d = window.__lm.D();
    return d?.p && d.edit && !d.busy && !d.again;
  }, null, { timeout: 60000 });
}
