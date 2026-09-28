// Safari's module workers have no importScripts. MediaPipe then reaches for `document` and the face and
// people models fail with "Can't find variable: document". This removes importScripts from the worker
// (before mp.js runs, as in Safari) and checks that both models still start.
// usage: tools/with-server.sh node tools/e2e_worker_no_importscripts.mjs <photo with a person>
import { chromium } from 'playwright';
const photo = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
await ctx.route('**/mp.js', async (r) => {
  const res = await r.fetch();
  await r.fulfill({ response: res, body: `Object.defineProperty(self, 'importScripts', { value: undefined, writable: true, configurable: true });\n${await res.text()}` });
});
const page = await ctx.newPage();
await page.goto('http://localhost:8765/');
await page.waitForTimeout(500);
await page.setInputFiles('#pickPhotos', [photo]);
await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'ready', null, { timeout: 90000 });
const r = await page.evaluate(() => { const p = window.__lm.S.photos[0]; return { mask: p.mask, faceErr: p.faceErr }; });
await browser.close();
console.log(JSON.stringify(r));
if (!r.mask.ok || r.faceErr || !r.mask.people || !(r.mask.skin > 0)) { console.log('FAIL: models did not start without importScripts'); process.exit(1); }
console.log('ok: people, skin and face models start without importScripts');
