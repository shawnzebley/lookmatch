// Add picked-range color measurements without changing existing bundled look targets.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const url = process.argv[2];
if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url)) throw new Error('Provide a local app URL.');
const file = 'web/looks/cvatik.json', looks = JSON.parse(await fs.readFile(file, 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const look of looks) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__lm?.pool);
    const bytes = (await fs.readFile(`scratch/cvatik/${look.id}-after.jpg`)).toString('base64');
    let timeout;
    const stats = await Promise.race([page.evaluate(async ({ bytes, id }) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${bytes}`)).blob();
      return (await window.__lm.pool.call(0, 'measureRef', { file: new File([blob], `${id}.jpg`, { type: 'image/jpeg' }) })).stats;
    }, { bytes, id: look.id }), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${look.id}: measurement timed out`)), 60000);
    })]).finally(() => clearTimeout(timeout));
    await page.close();
    for (const scope of ['all', 'subject', 'background']) {
      const target = look.reference.after.adaptiveTransfer?.[scope];
      if (target) target.colorSamples = stats.adaptiveTransfer?.[scope]?.colorSamples || [];
    }
    console.log(`${look.id}: color-range samples added`);
  }
  const sampleArrays = [];
  const formatted = JSON.stringify(looks, (key, value) => {
    if (key !== 'colorSamples') return value;
    sampleArrays.push(value);
    return `__COLOR_RANGE_SAMPLES_${sampleArrays.length - 1}__`;
  }, 2).replace(/"__COLOR_RANGE_SAMPLES_(\d+)__"/g, (_, index) => JSON.stringify(sampleArrays[Number(index)]));
  assert.deepEqual(JSON.parse(formatted), looks);
  await fs.writeFile(file, formatted + '\n');
} finally { await browser.close(); }
