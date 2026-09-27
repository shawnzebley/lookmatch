// Headless test of subject / background: people found on load, a reference's own split measured,
// the style fitting subject vs background, Subject tab local sliders, tap to add, undo, full-res export.
// usage: tools/with-server.sh node tools/e2e_subject.mjs <out dir> <reference photo> <photo> [photographer]
import { chromium } from 'playwright';
import fs from 'fs';
const [shots = 'scratch/e2e_subject', refPath, photoPath, who = 'cvatik'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (/unavailable|mask failed/.test(m.text())) errs.push('[warn] ' + m.text().slice(0, 400)); if (m.type() === 'error' && !/TensorFlow|XNNPACK|favicon/.test(m.text())) errs.push(`[console] ${m.text()}`); });
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png` });
const S = (f, a) => page.evaluate(f, a);
const P = () => S(() => { const p = window.__lm.S.photos[0]; return { status: p.status, mask: p.mask, regions: p.regions, local: p.params && p.params.local, error: p.error }; });

await page.goto('http://localhost:8765/');
await page.waitForTimeout(400);

// reference with its own subject / background
let t = Date.now();
await page.setInputFiles('#pickRef', refPath);
await page.waitForSelector('#npSave:not([disabled])', { timeout: 90000 });
await page.click('#npSave');
await page.waitForTimeout(400);
console.log(`reference measured in ${((Date.now() - t) / 1000).toFixed(1)} s; regions:`, JSON.stringify(await S(() => { const r = window.__lm.S.presets[0].stats.regions; return r && { frac: +r.frac.toFixed(3), sep: +r.sep.toFixed(1), dA: +r.dA.toFixed(1), dB: +r.dB.toFixed(1), logC: +r.logC.toFixed(2) }; })));

t = Date.now();
await page.setInputFiles('#pickPhotos', [photoPath]);
await page.waitForFunction(() => ['done', 'error'].includes(window.__lm.S.photos[0]?.status), null, { timeout: 120000 });
console.log(`photo styled in ${((Date.now() - t) / 1000).toFixed(1)} s:`, JSON.stringify(await P()));
if (await page.$eval('#detail', (e) => e.hidden)) await page.click('.strip .tile:not(.add)');
await page.waitForFunction(() => document.querySelector('#cv')?.width > 0, null, { timeout: 30000 });
await page.waitForTimeout(800);
await shot('01_editor');
await page.evaluate(() => document.querySelector('#regionCard').scrollIntoView());
await page.waitForTimeout(400);
await shot('02_region_card');
console.log('region card:', (await page.$eval('#regionCard', (e) => e.innerText)).replace(/\n+/g, ' | '));

// Subject tab: the flash shows the subject, the sliders are the local ones
await page.click('#rSeg button[data-r=subject]');
await page.waitForTimeout(500);
await shot('03_subject_tab_flash');
console.log('subject sliders:', await page.$$eval('#sliders .sl label', (ls) => ls.map((l) => l.textContent).join(', ')));
await page.$eval('#sliders .sl[data-k=exposure] input[type=range]', (r) => { r.value = '0.6'; r.dispatchEvent(new Event('input')); });
await page.waitForTimeout(1800);
await shot('04_subject_exposure');
console.log('local after slider:', JSON.stringify(await S(() => window.__lm.S.photos[0].params.local)));

// background tab + show mask
await page.click('#rSeg button[data-r=background]');
if (await page.$eval('#mShow', (b) => b.disabled)) { console.log(errs.join('\n')); process.exit(1); }
await page.click('#mShow');
await page.waitForTimeout(1200);
await shot('05_background_mask');
if (await page.$eval('#mShow', (b) => b.disabled)) { console.log(errs.join('\n')); process.exit(1); }
await page.click('#mShow');

// tap to add a spot in the corner, then undo
await page.click('#rSeg button[data-r=all]');
await page.click('#mAdd');
const box = await page.$eval('#cv', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
await page.mouse.click(box.x + box.w * 0.08, box.y + box.h * 0.9);
await page.waitForFunction(() => window.__lm.S.photos[0].mask?.picks === 1 || /Nothing found|outside/.test(document.querySelector('#toast').textContent), null, { timeout: 60000 });
await page.waitForTimeout(1500);
await shot('06_tap_added');
console.log('after tap:', JSON.stringify((await P()).mask), '| toast:', await page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent)));
await page.click('#mAdd');
if ((await P()).mask.picks) { await page.click('#mUndo'); await page.waitForFunction(() => window.__lm.S.photos[0].mask?.picks === 0, null, { timeout: 60000 }); }
console.log('after undo:', JSON.stringify((await P()).mask));

// full-resolution export with the two regions
const exportTo = async (file) => {
  const t0 = Date.now();
  const ex = await S(async () => {
  const p = window.__lm.S.photos[0];
  const r = await window.__lm.pool.call(p.worker, 'export', { id: p.id, params: p.params, quality: 90, lightroom: false, name: 'x' });
  const b = new Uint8Array(await r.jpeg.arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { w: r.width, h: r.height, ms: r.ms, b64: btoa(s) };
  });
  fs.writeFileSync(`${shots}/${file}`, Buffer.from(ex.b64, 'base64'));
  console.log(`export ${file} ${ex.w}x${ex.h} in ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(ex.ms));
};
await exportTo('export_reference.jpg');

// photographer style on the same photo
await page.click('#dSeg button[data-k=photographer]');
await page.click(`#dPick button[data-l="photographer:${who}"]`);
await page.waitForFunction(() => window.__lm.S.photos[0].status === 'done' && window.__lm.S.photos[0].style, null, { timeout: 120000 });
await page.waitForTimeout(1200);
console.log(`${who}:`, JSON.stringify((await P()).regions));
await page.evaluate(() => document.querySelector('#regionCard').scrollIntoView());
await page.waitForTimeout(300);
await shot('07_photographer_region');
console.log('region card:', (await page.$eval('#regionCard', (e) => e.innerText)).replace(/\n+/g, ' | '));
await exportTo('export_photographer.jpg');
// same photographer with the split off, for comparison
await page.click('#mSplit');
await page.waitForFunction(() => window.__lm.S.photos[0].status === 'done' && !window.__lm.S.photos[0].regions, null, { timeout: 120000 });
await exportTo('export_photographer_nosplit.jpg');
console.log(errs.slice(0, 10).join('\n') || 'no page errors');
await browser.close();
