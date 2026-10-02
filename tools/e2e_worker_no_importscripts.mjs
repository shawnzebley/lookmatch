// Face, people and skin detection on iPhone. MediaPipe's loader reaches for `document` (which a worker doesn't
// have) in two cases: there is no importScripts (Safari's module workers), and its user-agent test says
// "Safari without a usable OffscreenCanvas" (a Safari token without `Version/`). This removes importScripts
// before mp.js runs and tries three iPhone user agents; the face and people models must start on all of them.
// usage: tools/with-server.sh node tools/e2e_worker_no_importscripts.mjs <photo with a person>
import { chromium } from 'playwright';
const photo = process.argv[2];
const UAS = {
  'Safari 26': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  'Home-screen app (no Safari token)': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Safari token, no Version': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
};
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
let bad = 0;
for (const [name, ua] of Object.entries(UAS)) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, userAgent: ua, serviceWorkers: 'block' });
  await ctx.route('**/mp.js', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: `Object.defineProperty(self, 'importScripts', { value: undefined, writable: true, configurable: true });\n${await res.text()}` });
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8765/');
  await page.waitForTimeout(400);
  await page.setInputFiles('#pickPhotos', [photo]);
  await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'ready', null, { timeout: 90000 });
  const r = await page.evaluate(() => { const p = window.__lm.S.photos[0]; return { ok: p.mask.ok, err: p.mask.err, people: p.mask.people, skin: +p.mask.skin.toFixed(3), faceErr: p.faceErr }; });
  const good = r.ok && !r.faceErr && r.people && r.skin > 0;
  if (!good) bad++;
  console.log(`${good ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(r)}`);
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
