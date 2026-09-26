// Builds the HTML test report from out/*.json and out/*_ba.jpg
import fs from 'fs';
import sharp from 'sharp';
import { PCTS } from '../engine/measure.js';
const out = process.argv[2] || 'report.html';
const files = fs.readdirSync('out').filter((f) => /^t\d\d.*\.json$/.test(f) && !/(_faces|\.flip)\.json$/.test(f)).sort();
const labels = {
  t01_image: 'Indoor, mixed light', t02_image: 'Train car, window light', t03_image: 'Indoor portrait, window', t04_image: 'Dusk, building light',
  t05_image: 'Bright sun', t06_image: 'Night, string lights', t07_DSC08127: 'Indoor, overcast window', t08_DSC07441: 'Dark theater',
  t09_image: 'Night, lot lights', t10_DSC07626: 'Overcast, bright field', t11_P4271956: 'Overcast playground',
};
const ref = await sharp('testdata/in/ref.jpg').resize(360).jpeg({ quality: 80 }).toBuffer();
const rows = [];
for (const f of files) {
  const name = f.replace('.json', '');
  const j = JSON.parse(fs.readFileSync(`out/${f}`));
  const { before: b, after: a, targets: T, params, timings } = j;
  const tone = (s) => PCTS.reduce((acc, q) => acc + Math.abs(s.tone.pct[q] - T.tone.pct[q]), 0) / PCTS.length;
  const wb = (s) => Math.hypot(s.wb.a - T.wb.a, s.wb.b - T.wb.b);
  const zs = Object.keys(T.zones);
  const zone = (s) => (zs.length ? zs.reduce((acc, z) => acc + Math.hypot(s.zones[z].a - T.zones[z].a, s.zones[z].b - T.zones[z].b), 0) / zs.length : 0);
  const clipHi = Math.max(0, a.tone.clipHi - b.tone.clipHi) * 100, clipLo = Math.max(0, a.tone.clipLo - b.tone.clipLo) * 100;
  const skinOn = b.skin.source === 'faces' || b.skin.frac > 0.005;
  const lo = Math.min(35, b.skin.hue - 2), hi = Math.max(65, b.skin.hue + 2);
  const skinOk = !skinOn || (a.skin.hue >= lo && a.skin.hue <= hi && a.skin.litChroma >= 0.6 * b.skin.litChroma && !(j.loss?.issues || []).some((i) => i.kind === 'dullSkin'));
  const flipPath = `out/${name}.flip.json`;
  const flipRes = fs.existsSync(flipPath) ? JSON.parse(fs.readFileSync(flipPath, 'utf8')) : null;
  const img = await sharp(`out/${name}_ba.jpg`).resize(1000).jpeg({ quality: 76 }).toBuffer();
  rows.push({
    name, label: labels[name] || name, img: img.toString('base64'),
    med: [b.tone.pct[50], a.tone.pct[50], T.tone.pct[50]],
    tone: [tone(b), tone(a)], wb: [wb(b), wb(a)], zone: [zone(b), zone(a)],
    chroma: [b.color.meanChroma, a.color.meanChroma, T.color.meanChroma],
    p1p99: [b.tone.pct[1], b.tone.pct[99], a.tone.pct[1], a.tone.pct[99]],
    clip: [clipHi, clipLo],
    skin: skinOn ? [b.skin.hue, a.skin.hue, b.skin.litChroma, a.skin.litChroma] : null,
    pass: { tone: tone(a) <= 3, wb: wb(a) <= 2, zone: zone(a) <= 4, clip: clipHi <= 0.1 && clipLo <= 0.1, skin: skinOk },
    ms: timings.total, params,
    scene: j.scene, faces: b.skin.source === 'faces' ? b.skin.faces : 0,
    flip: flipRes, warnings: (j.loss?.issues || []).map((i) => ({ level: i.level, text: i.text })),
  });
}
const f1 = (v) => (+v).toFixed(1);
const PASS = (ok) => `<span class="pill ${ok ? 'ok' : 'no'}">${ok ? 'pass' : 'miss'}</span>`;
const count = (k) => rows.filter((r) => r.pass[k]).length;
const top = (p) => {
  const keys = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'saturation', 'vibrance'];
  return keys.map((k) => `<span><b>${{ exposure: 'Exp', contrast: 'Con', highlights: 'Hi', shadows: 'Sh', whites: 'Wh', blacks: 'Bl', temp: 'Temp', tint: 'Tint', saturation: 'Sat', vibrance: 'Vib' }[k]}</b> ${k === 'exposure' ? (+p[k]).toFixed(2) : Math.round(p[k])}</span>`).join('');
};
const NOTES = fs.existsSync('tools/report-notes.html') ? fs.readFileSync('tools/report-notes.html', 'utf8') : '';
const html = `<title>LookMatch Test Run</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#eef0f1;--panel:#ffffff;--ink:#16191d;--muted:#5d646c;--line:#d8dcdf;--accent:#a8701a;--ok:#2d7a47;--okbg:#e2f1e6;--no:#b0452c;--nobg:#f7e3dd;--warn:#8a6414;--warnbg:#f6ecd2;
  --sans:"Instrument Sans",-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121416;--panel:#1b1e22;--ink:#e9e7e3;--muted:#9aa0a7;--line:#2e3237;--accent:#e8b04a;--ok:#7cc48a;--okbg:#1d3324;--no:#e38a74;--nobg:#3a221c;--warn:#f3c969;--warnbg:#2a2210;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121416;--panel:#1b1e22;--ink:#e9e7e3;--muted:#9aa0a7;--line:#2e3237;--accent:#e8b04a;--ok:#7cc48a;--okbg:#1d3324;--no:#e38a74;--nobg:#3a221c;--warn:#f3c969;--warnbg:#2a2210;color-scheme:dark}
body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);padding-inline:16px}
.wrap{max-width:1040px;margin:0 auto;padding-block:28px 60px;display:flex;flex-direction:column;gap:28px}
h1{font-size:30px;line-height:1.15;margin:0;font-weight:700;letter-spacing:-.015em;text-wrap:balance}
h2{font-size:19px;margin:0;font-weight:650;text-wrap:balance}
p{margin:0;max-width:68ch}
.muted{color:var(--muted)}
.head{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:start}
.head img{width:150px;border-radius:8px;display:block}
.head figcaption{font:12px var(--mono);color:var(--muted);margin-top:6px;text-align:center}
.intro{display:flex;flex-direction:column;gap:10px}
.eyebrow{font:500 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.tallies{display:flex;flex-wrap:wrap;gap:8px}
.tally{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px}
.tally b{font:600 17px var(--mono);margin-right:6px}
.tablebox{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font-weight:500;color:var(--muted);font-size:12px;vertical-align:bottom}
td:first-child,th:first-child{text-align:left}
td.num{font-family:var(--mono);font-size:12.5px}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;font:500 11px var(--mono);padding:1px 6px;border-radius:99px;margin-left:6px}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.no{background:var(--nobg);color:var(--no)}.pill.warn{background:var(--warnbg);color:var(--warn)}
.photo{display:flex;flex-direction:column;gap:10px}
.photo .ttl{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.photo .ttl span{font:12px var(--mono);color:var(--muted)}
.photo img{width:100%;border-radius:8px;display:block}
.cap{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:-4px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 16px;font-size:13px}
.kv div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed var(--line);padding-bottom:3px}
.kv div span:last-child{font-family:var(--mono);font-size:12.5px}
.params{display:flex;flex-wrap:wrap;gap:4px 14px;font:12px var(--mono);color:var(--muted)}
.params b{color:var(--ink);font-weight:500}
.notes{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:8px}
.notes ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;max-width:75ch}
@media (max-width:560px){.head{grid-template-columns:1fr}.head figure{margin:0}.head img{width:120px}h1{font-size:25px}}
</style>
<div class="wrap">
<header class="head"><div class="intro"><div class="eyebrow">Engine test · 11 photos · 1 reference · run 2: face detection, camera settings, FLIP</div>
<h1>LookMatch against your 11 test photos</h1>
<p class="muted">Each photo was measured, solved on its own at 100% strength, and re-measured. This run adds face outlines from MediaPipe for the skin guard, the camera’s exposure settings for the brightness rule, and NVIDIA FLIP to compare how much the edit changed faces versus the rest of the scene. “Target” is what the solver aimed for: the reference’s look, with brightness only partly pulled toward the reference so night shots stay night shots. Errors are in L* units (tone) or Lab units (color). Lower is closer.</p>
<div class="tallies"><div class="tally"><b>${count('tone')}/11</b>tone within 3 L*</div><div class="tally"><b>${count('wb')}/11</b>neutral cast within 2</div><div class="tally"><b>${count('zone')}/11</b>zone color within 4</div><div class="tally"><b>${count('clip')}/11</b>no new clipping over 0.1%</div><div class="tally"><b>${count('skin')}/11</b>skin believable</div></div></div>
<figure style="margin:0"><img src="data:image/jpeg;base64,${ref.toString('base64')}" alt="Reference photo"><figcaption>reference</figcaption></figure></header>

<section class="tablebox"><table>
<tr><th>Photo</th><th>Scene (camera)</th><th>Faces</th><th>Median L*<br>before › after (target)</th><th>Tone error<br>before › after</th><th>Neutral cast<br>before › after</th><th>Zone color<br>before › after</th><th>Mean chroma<br>before › after (target)</th><th>New clip %<br>hi / lo</th><th>Skin hue°<br>before › after</th><th>FLIP faces ÷ scene</th><th>App warnings</th><th>Solve</th></tr>
${rows.map((r) => `<tr><td>${r.name.slice(0, 3)} · ${r.label}</td>
<td class="num">${r.scene ? `${r.scene.label} · EV ${f1(r.scene.ev)}` : '–'}</td>
<td class="num">${r.faces || '–'}</td>
<td class="num">${f1(r.med[0])} › ${f1(r.med[1])} (${f1(r.med[2])})</td>
<td class="num">${f1(r.tone[0])} › ${f1(r.tone[1])}${PASS(r.pass.tone)}</td>
<td class="num">${f1(r.wb[0])} › ${f1(r.wb[1])}${PASS(r.pass.wb)}</td>
<td class="num">${f1(r.zone[0])} › ${f1(r.zone[1])}${PASS(r.pass.zone)}</td>
<td class="num">${f1(r.chroma[0])} › ${f1(r.chroma[1])} (${f1(r.chroma[2])})</td>
<td class="num">${r.clip[0].toFixed(2)} / ${r.clip[1].toFixed(2)}${PASS(r.pass.clip)}</td>
<td class="num">${r.skin ? `${f1(r.skin[0])} › ${f1(r.skin[1])}${PASS(r.pass.skin)}` : 'no skin'}</td>
<td class="num">${r.flip?.face_ratio != null ? `${r.flip.face_ratio}×` : '–'}</td>
<td class="num">${r.warnings.length ? r.warnings.map((w) => `<span class="pill ${w.level === 'bad' ? 'no' : 'warn'}">${w.text}</span>`).join(' ') : '<span class="pill ok">none</span>'}</td>
<td class="num">${(r.ms / 1000).toFixed(1)} s</td></tr>`).join('')}
</table></section>

<section class="notes"><h2>What changed since run 1, and what’s still off</h2><ul>
${NOTES}
</ul></section>

${rows.map((r) => `<section class="photo"><div class="ttl"><h2>${r.name} · ${r.label}</h2><span>solve ${(r.ms / 1000).toFixed(1)} s</span></div>
<img loading="lazy" src="data:image/jpeg;base64,${r.img}" alt="${r.label}, before and after">
<div class="cap"><span>Before</span><span>After</span></div>
<div class="kv"><div><span>Black / white before</span><span>${f1(r.p1p99[0])} / ${f1(r.p1p99[1])}</span></div><div><span>Black / white after</span><span>${f1(r.p1p99[2])} / ${f1(r.p1p99[3])}</span></div>
<div><span>Tone error</span><span>${f1(r.tone[0])} › ${f1(r.tone[1])}</span></div><div><span>Zone color</span><span>${f1(r.zone[0])} › ${f1(r.zone[1])}</span></div>
${r.skin ? `<div><span>Lit-skin chroma</span><span>${f1(r.skin[2])} › ${f1(r.skin[3])}</span></div>` : ''}</div>
<div class="params">${top(r.params)}</div></section>`).join('')}
</div>`;
fs.writeFileSync(out, html);
console.log(out, (html.length / 1e6).toFixed(2), 'MB');
