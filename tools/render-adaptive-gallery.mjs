import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import sharp from 'sharp';
const [url, source] = process.argv.slice(2);
const out = 'scratch/adaptive-e2e';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.setInputFiles('#pickPhotos', source);
  await page.waitForFunction(() => ['ready', 'done'].includes(window.__lm.S.photos[0]?.status), null, { timeout: 90000 });
  const tiles = [];
  for (let i = 0; i < 12; i++) {
    const data = await page.evaluate(async i => {
      const { S, pool } = window.__lm, photo = S.photos[0], profile = S.presets.filter(p => p.builtin)[i].adaptiveLook;
      const solved = await pool.call(photo.worker, 'solve', { id: photo.id, adaptiveLook: profile, strength: 1, skinProtection: 1 });
      const { edited } = await pool.call(photo.worker, 'preview', { id: photo.id, params: solved.params, side: 512 });
      const c = document.createElement('canvas'); c.width = edited.width; c.height = edited.height;
      c.getContext('2d').drawImage(edited, 0, 0); edited.close();
      return { jpg: c.toDataURL('image/jpeg', 0.88).split(',')[1], id: profile.id, thumb: profile.thumb, params: solved.params, adaptive: solved.adaptive };
    }, i);
    await fs.writeFile(`${out}/${data.id}.jpg`, Buffer.from(data.jpg, 'base64'));
    delete data.jpg;
    await fs.writeFile(`${out}/${data.id}.json`, JSON.stringify(data, null, 2));
    const left = (i % 3) * 480, top = Math.floor(i / 3) * 240;
    tiles.push({ input: await sharp(`web/${data.thumb}`).resize(160, 215, { fit: 'contain', background: '#222' }).toBuffer(), left, top });
    tiles.push({ input: await sharp(`${out}/${data.id}.jpg`).resize(320, 215, { fit: 'contain', background: '#222' }).toBuffer(), left: left + 160, top });
    tiles.push({ input: Buffer.from(`<svg width="480" height="25"><rect width="480" height="25" fill="#222"/><text x="8" y="18" fill="white" font-size="14">${data.id}: target / adaptive result on the same source photo</text></svg>`), left, top: top + 215 });
  }
  await sharp({ create: { width: 1440, height: 960, channels: 3, background: '#222' } }).composite(tiles).jpeg({ quality: 90 }).toFile(`${out}/rendered-gallery.jpg`);
  console.log('Rendered all twelve actual worker looks and their calculated recipes.');
} finally { await browser.close(); }
