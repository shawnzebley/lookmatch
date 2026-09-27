// Headless test of the main flow: select a photo -> pick a photographer (editor opens) -> switch this
// photo to a reference -> back -> add more photos -> switch everyone to another photographer.
// usage: tools/with-server.sh node tools/e2e_flow.mjs scratch/e2e_flow
import { chromium } from 'playwright';
import fs from 'fs';
const shots = process.argv[2] || 'scratch/e2e_flow';
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/TensorFlow|XNNPACK/.test(m.text())) errs.push(`[console] ${m.text()}`); });
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png` });
const S = (f) => page.evaluate(f);

await page.goto('http://localhost:8765/');
await page.waitForTimeout(500);
await shot('01_home');

await page.setInputFiles('#pickPhotos', ['testdata/in/kodim05.png']);
await page.waitForFunction(() => window.__lm.S.photos[0]?.status === 'ready', null, { timeout: 60000 });
await page.waitForTimeout(300);
await shot('02_one_photo');
console.log('status without style:', await page.$eval('.strip .tile:not(.add) .st', (e) => e.textContent));

await page.click('.pcard:nth-child(1)'); // Cvatik
await page.waitForFunction(() => !document.querySelector('#detail').hidden && window.__lm.S.photos[0].status === 'done', null, { timeout: 60000 });
await page.waitForTimeout(900);
await shot('03_editor_opened');
console.log('editor style card:', (await page.$eval('#styleCard', (e) => e.innerText)).split('\n').slice(0, 8).join(' | '));
await page.evaluate(() => document.querySelector('#detail').scrollTo(0, 330));
await page.waitForTimeout(300);
await shot('04_editor_style_card');

// this photo -> a reference
await page.click('#dSeg button[data-k=preset]');
await page.setInputFiles('#pickRef', 'testdata/in/kodim23.png');
await page.waitForSelector('#npSave:not([disabled])', { timeout: 60000 });
await page.fill('#npName', 'Parrots');
await page.click('#npSave');
await page.waitForFunction(() => window.__lm.S.photos[0].status === 'done' && window.__lm.S.look.kind === 'preset', null, { timeout: 60000 });
await page.waitForTimeout(1200);
console.log('after reference: look', JSON.stringify(await S(() => window.__lm.S.look)), '| card:', (await page.$eval('#styleCard', (e) => e.innerText)).split('\n').slice(0, 4).join(' | '));
await shot('05_editor_reference');

await page.click('#dBack');
await page.setInputFiles('#pickPhotos', ['testdata/in/kodim20.png', 'testdata/in/big24.jpg']);
await page.waitForFunction(() => window.__lm.S.photos.every((p) => p.status === 'done'), null, { timeout: 120000 });
await page.waitForTimeout(300);
await shot('06_three_photos_reference');
await page.click('#styleSeg button[data-k=photographer]');
await page.waitForTimeout(200);
await page.click('.pcard:nth-child(3)'); // Xenie
await page.waitForFunction(() => window.__lm.S.photos.every((p) => p.status === 'done' && p.style), null, { timeout: 120000 });
await page.waitForTimeout(300);
console.log('all photos:', JSON.stringify(await S(() => window.__lm.S.photos.map((p) => [p.name, p.status, p.style?.name]))));
console.log('header actions:', await page.$eval('#topActions', (e) => e.innerText));
await shot('07_three_photos_xenie');
await page.evaluate(() => window.scrollTo(0, 400));
await page.waitForTimeout(200);
await shot('08_scrolled');
console.log(errs.slice(0, 10).join('\n') || 'no page errors');
await browser.close();
