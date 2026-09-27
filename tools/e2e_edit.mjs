// Headless test of: HEIF/HIF upload (libheif fallback in Chromium), photographer finish + colour wheels,
// stage shrinking on scroll, crop + level, export size and Lightroom crop fields.
// usage: tools/with-server.sh node tools/e2e_edit.mjs scratch/e2e_edit
import { chromium } from 'playwright';
import fs from 'fs';
const shots = process.argv[2] || 'scratch/e2e_edit';
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:8765/');
await page.waitForTimeout(400);

await page.setInputFiles('#pickRef', 'testdata/in/kodim23.png');
await page.waitForSelector('#npSave:not([disabled])', { timeout: 60000 });
await page.click('#npSave');
await page.waitForTimeout(300);
await page.click('.preset [data-a=use]');

const files = ['DSCF0001.HIF', 'IMG_0002.HEIC', 'big24.jpg', 'kodim05.png'].map((f) => 'testdata/in/' + f);
const t0 = Date.now();
await page.setInputFiles('#pickPhotos', files);
await page.waitForFunction((n) => window.__lm.S.photos.filter((p) => p.status === 'done' || p.status === 'error').length === n, files.length, { timeout: 300000 });
console.log(`matched in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(await page.evaluate(() => window.__lm.S.photos.map((p) => `${p.name}: ${p.status}${p.error ? ' ' + p.error : ''} ${p.w}x${p.h}${p.converted ? ' converted ' + p.converted : ''}`).join('\n')));
await page.screenshot({ path: `${shots}/01_grid.png` });

// detail of the HIF, pick Cvatik
await page.click('.tile');
await page.waitForFunction(() => document.querySelector('#cv')?.width > 0, null, { timeout: 30000 });
await page.click('#fin button[data-f=cvatik]');
await page.waitForFunction(() => window.__lm.S.photos[0].style, null, { timeout: 60000 });
await page.waitForTimeout(800);
console.log('style:', JSON.stringify(await page.evaluate(() => { const s = window.__lm.S.photos[0].style; return { basis: s.basis, k: s.k, n: s.n, wheels: s.wheels, sat: s.sat, blacks: s.blacks, vig: s.vignette }; })));
console.log('note:', await page.$eval('#finNote', (e) => e.innerText));
await page.screenshot({ path: `${shots}/02_detail_top.png` });
const h0 = await page.$eval('#stage', (e) => e.getBoundingClientRect().height);
await page.evaluate(() => document.querySelector('#detail').scrollTo(0, 260));
await page.waitForTimeout(250);
const h1 = await page.$eval('#stage', (e) => e.getBoundingClientRect().height);
await page.evaluate(() => document.querySelector('#detail').scrollTo(0, 2000));
await page.waitForTimeout(250);
const h2 = await page.$eval('#stage', (e) => e.getBoundingClientRect().height);
console.log(`stage height: top ${h0}, scrolled 260 -> ${h1}, scrolled far -> ${h2}`);
await page.evaluate(() => { const det = document.querySelector('#detail'); det.scrollTop += document.querySelector('#grade').getBoundingClientRect().top - document.querySelector('.dtop').getBoundingClientRect().bottom - 60; });
await page.waitForTimeout(250);
await page.screenshot({ path: `${shots}/03_wheels.png` });

// drag the shadows wheel
const wb = await page.$eval('#grade .wh[data-z=shadow] canvas', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width]; });
await page.mouse.move(wb[0] + wb[2] * 0.5, wb[1] + wb[2] * 0.5);
await page.mouse.down(); await page.mouse.move(wb[0] + wb[2] * 0.2, wb[1] + wb[2] * 0.75, { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(600);
console.log('shadow wheel after drag:', await page.evaluate(() => { const p = window.__lm.S.photos[0].params; return [p.shadowHue, p.shadowSat]; }));

// crop + level
await page.evaluate(() => document.querySelector('#detail').scrollTo(0, 0));
await page.waitForTimeout(200);
await page.click('#cropBtn');
await page.waitForTimeout(1200);
await page.$eval('#lvl', (e) => { e.value = '4.5'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
await page.click('#aspects button[data-a="0.8"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/04_crop.png` });
// drag the top-left corner inward
const cb = await page.$eval('#cv', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
const r0 = await page.evaluate(() => ({ ...window.__lm.D().crop.r }));
await page.mouse.move(cb[0] + r0.x * cb[2] + 2, cb[1] + r0.y * cb[3] + 2);
await page.mouse.down(); await page.mouse.move(cb[0] + (r0.x + 0.1) * cb[2], cb[1] + (r0.y + 0.1) * cb[3], { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/05_crop_dragged.png` });
await page.click('#lvlAuto');
await page.waitForTimeout(1500);
await page.click('#cropDone');
await page.waitForFunction(() => window.__lm.S.photos[0].status === 'done' && window.__lm.S.photos[0].geom, null, { timeout: 60000 });
await page.waitForTimeout(1200);
const geom = await page.evaluate(() => window.__lm.S.photos[0].geom);
console.log('geom:', JSON.stringify(geom));
await page.screenshot({ path: `${shots}/06_cropped.png` });

// export to device
await page.evaluate(() => { window.__lm.S.settings.dest = 'device'; });
await page.click('#dExport');
await page.waitForSelector('#expActs a[download]', { timeout: 180000 });
const links = await page.$$eval('#expActs a[download]', (as) => as.map((a) => a.getAttribute('download')));
console.log('export files:', links.join(', '));
for (const name of links) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`#expActs a[download="${name}"]`)]);
  await dl.saveAs(`${shots}/${name}`);
}
console.log(logs.filter((l) => !l.includes('DevTools')).slice(0, 25).join('\n'));
await browser.close();
