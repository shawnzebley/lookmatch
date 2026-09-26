// Runs MediaPipe face detection (the same code the app uses) on test photos in headless Chromium,
// and caches the face outlines in testdata/faces.json for tools/match.mjs.
// Usage: tools/with-server.sh node tools/faces.mjs testdata/in/*.jpg testdata/in/*.png
import { chromium } from 'playwright';
import fs from 'fs';
import sharp from 'sharp';
import { toSharp } from './load.mjs';
const out = fs.existsSync('testdata/faces.json') ? JSON.parse(fs.readFileSync('testdata/faces.json', 'utf8')) : {};
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
await p.goto('http://localhost:8765/index.html');
await p.evaluate(() => { window.__fw = new Worker('./facetest-worker.js', { type: 'module' }); });
for (const f of process.argv.slice(2)) {
  const jpg = await (await toSharp(f)).resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const r = await p.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Promise((res) => { window.__fw.onmessage = (e) => res(e.data); window.__fw.postMessage({ blob: new Blob([bin], { type: 'image/jpeg' }), full: true }); });
  }, jpg.toString('base64'));
  out[f.split('/').pop()] = r.faces || [];
  console.log(f, r.ok ? `${(r.faces || []).length} face(s), ${Math.round(r.ms)} ms` : r.err);
}
fs.writeFileSync('testdata/faces.json', JSON.stringify(out));
await b.close();
