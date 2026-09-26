// Headless browser test of the web app: preset -> batch match -> detail -> slider -> export.
import { chromium } from 'playwright';
import fs from 'fs';
const shots = process.argv[2] || 'scratch';
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:8765/');
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/01_empty.png` });

// new preset
await page.setInputFiles('#pickRef', 'testdata/in/ref.jpg');
await page.waitForSelector('#npSave:not([disabled])', { timeout: 30000 });
await page.fill('#npName', 'Cinematic Cap');
await page.screenshot({ path: `${shots}/02_newpreset.png` });
await page.click('#npSave');
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/03_presets.png` });

// batch
await page.click('.preset [data-a=use]');
const files = ['t02_image.jpg', 't05_image.jpg', 't06_image.jpg', 't08_DSC07441.png'].map((f) => 'testdata/in/' + f);
const t0 = Date.now();
await page.setInputFiles('#pickPhotos', files);
await page.waitForFunction((n) => window.__lm.S.photos.filter((p) => p.status === 'done').length === n, files.length, { timeout: 180000 });
console.log(`batch of ${files.length} matched in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.screenshot({ path: `${shots}/04_batch.png` });
const timings = await page.evaluate(() => window.__lm.S.photos.map((p) => `${p.name}: ${Math.round(p.timings.total)} ms · ${p.scene ? p.scene.label + ' EV ' + p.scene.ev : 'no exif'} · skin from ${p.before.skin.source} (${p.before.skin.faces} faces) · warnings: ${p.loss.issues.map((i) => i.text).join(', ') || 'none'}`));
console.log(timings.join('\n'));

// detail
await page.click('.tile');
await page.waitForFunction(() => document.querySelector('#cv')?.width > 0, null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/05_detail.png` });
await page.screenshot({ path: `${shots}/06_detail_full.png`, fullPage: false });
// nudge exposure slider
const before = await page.evaluate(() => JSON.stringify(window.__lm.S.photos[0].params));
await page.$eval('.sl[data-k=exposure] input[type=number]', (el) => { el.value = '0.5'; el.dispatchEvent(new Event('change')); });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => JSON.stringify(window.__lm.S.photos[0].params));
const diff = Object.entries(JSON.parse(after)).filter(([k, v]) => JSON.parse(before)[k] !== v);
console.log('changed params after nudge:', JSON.stringify(diff));
await page.screenshot({ path: `${shots}/07_nudged.png` });
await page.evaluate(() => document.querySelector('#detail').scrollTo(0, 600));
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/08_numbers.png` });

// export to device (headless has no share sheet -> download links)
await page.evaluate(() => { window.__lm.S.settings.dest = 'device'; });
await page.click('#dExport');
await page.waitForSelector('#expActs a[download]', { timeout: 120000 });
const links = await page.$$eval('#expActs a[download]', (as) => as.map((a) => a.getAttribute('download')));
console.log('export files:', links.join(', '));
for (const name of links) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`#expActs a[download="${name}"]`)]);
  await dl.saveAs(`${shots}/${name}`);
}
await page.screenshot({ path: `${shots}/09_export.png` });
console.log(logs.filter((l) => !l.includes('DevTools')).slice(0, 20).join('\n'));
await browser.close();
