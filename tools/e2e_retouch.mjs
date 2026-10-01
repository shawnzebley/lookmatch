// Headless test of the portrait-workflow tools: cull dots + scenes + picks, skin smoothing and skin tone
// on the skin mask, heal spots (add, move source, opacity), point colour, sync to the other photos, and a
// full-resolution export with all of it.
// usage: tools/with-server.sh node tools/e2e_retouch.mjs <out dir> <portrait> <same scene, other exposure> <other photo>
import { chromium } from 'playwright';
import fs from 'fs';
const [shots = 'scratch/e2e_retouch', a, b, c] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (/unavailable|failed/.test(m.text())) errs.push('[warn] ' + m.text().slice(0, 400)); if (m.type() === 'error' && !/TensorFlow|XNNPACK|favicon/.test(m.text())) errs.push(`[console] ${m.text()}`); });
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png` });
const S = (f, x) => page.evaluate(f, x);
const fail = (msg) => { console.log('FAIL:', msg); console.log(errs.join('\n')); process.exit(1); };

await page.goto('http://localhost:8765/');
await page.waitForTimeout(400);
let t = Date.now();
await page.setInputFiles('#pickPhotos', [a, b, c]);
await page.waitForFunction(() => window.__lm.S.photos.length === 3 && window.__lm.S.photos.every((p) => p.status === 'ready' || p.status === 'error'), null, { timeout: 180000 });
console.log(`3 photos read in ${((Date.now() - t) / 1000).toFixed(1)} s`);
const cull = await S(() => window.__lm.S.photos.map((p) => ({ name: p.name, eyes: p.cull?.eyes, focus: p.cull?.focus, faces: p.cull?.faces?.map((f) => ({ closed: f.closed, focus: f.focus })), skin: p.mask?.skin && +p.mask.skin.toFixed(3) })));
console.log('cull:', JSON.stringify(cull));
console.log('strip:', (await page.$eval('.strip', (e) => e.innerText)).replace(/\n+/g, ' | '), '| scenes:', await page.$$eval('.strip .scene', (s) => s.length));
await page.click('.pcard:nth-child(1)'); // Cvatik
await page.waitForFunction(() => window.__lm.S.photos.every((p) => p.status === 'done' || p.status === 'error'), null, { timeout: 240000 });
if (!(await page.$eval('#detail', (e) => e.hidden))) await page.click('#dBack');
await page.waitForTimeout(300);
await page.click('#cullBest');
await page.waitForTimeout(300);
console.log('picks after best-of-scene:', JSON.stringify(await S(() => window.__lm.S.photos.map((p) => !!p.picked))));
await shot('01_strip_cull');
await page.click('#cullF button[data-f=picks]');
await page.waitForTimeout(300);
console.log('export button:', await page.$eval('#topActions', (e) => e.innerText));
await page.click('#cullF button[data-f=all]');

// editor on the portrait
await page.click('.strip .tile:not(.add)');
await page.waitForFunction(() => document.querySelector('#cv')?.width > 0, null, { timeout: 30000 });
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector('#retouchCard').scrollIntoView());
await page.waitForTimeout(300);
console.log('retouch card:', (await page.$eval('#retouchCard', (e) => e.innerText)).replace(/\n+/g, ' | '));
if (!(await page.$('#skOn'))) fail('no skin found on the portrait');
await page.click('#skOn');
await page.$eval('#skSl .sl[data-k=skinTone] input[type=range]', (r) => { r.value = '30'; r.dispatchEvent(new Event('input')); });
await page.waitForTimeout(1500);
console.log('skin params:', JSON.stringify(await S(() => { const q = window.__lm.S.photos[0].params; return { t: q.skinTexture, c: q.skinClarity, tone: q.skinTone }; })));

// heal: two spots on the face, move the second one's source, opacity 60
await page.click('#hlOn');
await page.click('#hlKind button[data-o="1"]');
// taps land on the photo as it is now (the stage shrinks as the page scrolls)
const tapAt = async (fx, fy) => {
  await page.evaluate(() => document.querySelector('#detail').scrollTop = 0);
  await page.waitForTimeout(300);
  const b = await page.$eval('#cv', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(b.x + b.w * fx, b.y + b.h * fy);
};
await tapAt(0.53, 0.33);
await page.waitForFunction(() => (window.__lm.S.photos[0].params.heals || []).length === 1, null, { timeout: 30000 });
await tapAt(0.45, 0.40);
await page.waitForFunction(() => (window.__lm.S.photos[0].params.heals || []).length === 2, null, { timeout: 30000 });
await page.click('#hlSrc');
await tapAt(0.45, 0.46);
await page.waitForTimeout(800);
await page.$eval('#hlSl .sl[data-k=hlOp] input[type=range]', (r) => { r.value = '60'; r.dispatchEvent(new Event('input')); });
await page.waitForTimeout(1500);
await shot('02_heal_spots');
console.log('heals:', JSON.stringify(await S(() => window.__lm.S.photos[0].params.heals.map((h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, +v.toFixed(3)]))))));
await page.click('#hlOn'); // done healing

// point colour: the orange suit, more saturated
await page.click('#ptPick');
await tapAt(0.9, 0.9);
await page.waitForFunction(() => (window.__lm.S.photos[0].params.points || []).length === 1, null, { timeout: 30000 });
await page.$eval('#ptSl .sl[data-k=sat] input[type=range]', (r) => { r.value = '50'; r.dispatchEvent(new Event('input')); });
await page.waitForTimeout(1500);
console.log('point:', JSON.stringify(await S(() => window.__lm.S.photos[0].params.points)));
await page.evaluate(() => document.querySelector('#detail').scrollTop = 0);
await page.click('#mode button[data-m=after]');
await page.waitForTimeout(1200);
await shot('03_after_retouch');

// sync: exposure/WB stay each photo's own, heals not copied
const before = await S(() => window.__lm.S.photos.map((p) => ({ exp: p.params.exposure, temp: p.params.temp })));
await page.evaluate(() => document.querySelector('#syncCard').scrollIntoView());
await page.click('#syGo');
await page.waitForTimeout(2500);
const after = await S(() => window.__lm.S.photos.map((p) => ({ exp: p.params.exposure, temp: p.params.temp, skin: p.params.skinTexture, heals: (p.params.heals || []).length, points: (p.params.points || []).length, contrast: p.params.contrast })));
console.log('sync before:', JSON.stringify(before));
console.log('sync after: ', JSON.stringify(after));
if (after[1].exp !== before[1].exp || after[1].heals !== 0 || after[1].skin !== after[0].skin || after[1].contrast !== after[0].contrast) fail('sync copied the wrong things');

// re-solve keeps the hand edits
await page.evaluate(() => document.querySelector('#detail').scrollTop = 0);
await page.click('#reMatch');
await page.waitForFunction(() => window.__lm.S.photos[0].status === 'done' && document.querySelector('#reMatch').textContent === 'Re-match', null, { timeout: 120000 });
console.log('after Re-match:', JSON.stringify(await S(() => { const q = window.__lm.S.photos[0].params; return { skin: q.skinTexture, heals: q.heals?.length, points: q.points?.length }; })));

// full-resolution export with skin pass + heals + point colour
t = Date.now();
const ex = await S(async () => {
  const p = window.__lm.S.photos[0];
  const r = await window.__lm.pool.call(p.worker, 'export', { id: p.id, params: p.params, quality: 92, lightroom: false, name: 'x' });
  const b = new Uint8Array(await r.jpeg.arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  // the same edit without retouching, for comparison
  const q = { ...p.params, skinTexture: 0, skinClarity: 0, skinTone: 0, heals: [], points: [] };
  const r2 = await window.__lm.pool.call(p.worker, 'export', { id: p.id, params: q, quality: 92, lightroom: false, name: 'y' });
  const b2 = new Uint8Array(await r2.jpeg.arrayBuffer());
  let s2 = ''; for (let i = 0; i < b2.length; i += 0x8000) s2 += String.fromCharCode(...b2.subarray(i, i + 0x8000));
  return { w: r.width, h: r.height, ms: r.ms, b64: btoa(s), b64n: btoa(s2) };
});
fs.writeFileSync(`${shots}/export_retouch.jpg`, Buffer.from(ex.b64, 'base64'));
fs.writeFileSync(`${shots}/export_plain.jpg`, Buffer.from(ex.b64n, 'base64'));
console.log(`export ${ex.w}x${ex.h} in ${((Date.now() - t) / 1000).toFixed(1)} s`, JSON.stringify(ex.ms));
console.log(errs.slice(0, 10).join('\n') || 'no page errors');
await browser.close();
