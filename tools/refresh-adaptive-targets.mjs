// Refresh bundled targets with the same subject/person analysis used by uploaded references.
// Run against a local app: node tools/refresh-adaptive-targets.mjs http://127.0.0.1:8877
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url)) throw new Error('Provide a local app URL.');
const file = 'web/looks/cvatik.json';
const profiles = JSON.parse(await fs.readFile(file, 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
const report = [];
try {
  for (const profile of profiles) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__lm?.pool);
    const bytes = (await fs.readFile(`scratch/cvatik/${profile.id}-after.jpg`)).toString('base64');
    let timeout;
    const stats = await Promise.race([page.evaluate(async ({ bytes, name }) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${bytes}`)).blob();
      const { stats } = await window.__lm.pool.call(0, 'measureRef', { file: new File([blob], name, { type: 'image/jpeg' }) });
      return stats;
    }, { bytes, name: `${profile.id}-after.jpg` }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${profile.id}: reference measurement timed out`)), 60000); })]).finally(() => clearTimeout(timeout));
    await page.close();
    // Adaptive transfer has its own skin-excluded palette and full-region tone targets.
    delete stats.labTransfer;
    profile.reference.after = stats;
    profile.reference.skinAfter = stats.skinMatch;
    profile.metadata.targetMaskMethod = 'browser-person-analysis';
    profile.metadata.targetMeasurementVersion = 2;
    const people = stats.skinMatch?.people?.length || 0;
    const regions = stats.regions?.subject?.n >= 20 && stats.regions?.background?.n >= 20;
    report.push({ id: profile.id, people, regions, skinAvailable: !!stats.skinMatch });
    console.log(`${profile.id}: ${people} skin people; regional targets ${regions ? 'available' : 'unavailable'}`);
  }
  await fs.writeFile(file, JSON.stringify(profiles, null, 2) + '\n');
  await fs.mkdir('output/playwright', { recursive: true });
  await fs.writeFile('output/playwright/adaptive-target-refresh.json', JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); }
