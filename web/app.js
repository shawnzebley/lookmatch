import { SLIDERS, defaultParams } from './engine/pipeline.js';
import { PCTS } from './engine/measure.js';
import { hsvToRgb } from './engine/color.js';
import * as db from './lib/db.js';
import * as drive from './lib/drive.js';

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const f1 = (v) => (v == null || isNaN(v) ? '–' : (+v).toFixed(1));
const blobURL = (b) => URL.createObjectURL(b);
const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const dataURLToBlob = async (u) => (await fetch(u)).blob();
const baseName = (n) => n.replace(/\.[^.]+$/, '');
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'lm_settings';
const S = {
  presets: [],
  settings: { clientId: '', quality: 92, lightroom: true, lrMode: 'sliders', dest: 'drive', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') },
  presetId: localStorage.getItem('lm_preset') || null,
  photos: [],
  tab: 'presets',
};
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings));

// ---------------------------------------------------------------- worker pool
const progressListeners = new Set();
class Pool {
  constructor(n) {
    this.workers = Array.from({ length: n }, (_, i) => this.spawn(i));
    this.rr = 0;
  }
  spawn(i) {
    const w = new Worker('./worker.js', { type: 'module' });
    w.idx = i; w.pending = new Map(); w.queue = []; w.running = 0; w.rid = 0;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.progress) { progressListeners.forEach((f) => f(m.progress)); return; }
      const p = w.pending.get(m.rid);
      if (!p) return;
      w.pending.delete(m.rid);
      m.ok ? p.res(m.res) : p.rej(new Error(m.error));
    };
    w.onerror = (e) => console.error('worker error', e);
    return w;
  }
  assign() { const w = this.workers[this.rr++ % this.workers.length]; return w.idx; }
  // one job at a time per worker, keeps memory flat on the phone
  call(idx, type, args, { priority = false } = {}) {
    const w = this.workers[idx];
    return new Promise((res, rej) => {
      const job = { type, args, res, rej };
      priority ? w.queue.unshift(job) : w.queue.push(job);
      this.pump(w);
    });
  }
  pump(w) {
    if (w.running || !w.queue.length) return;
    const job = w.queue.shift();
    w.running = 1;
    const rid = ++w.rid;
    w.pending.set(rid, {
      res: (r) => { w.running = 0; job.res(r); this.pump(w); },
      rej: (e) => { w.running = 0; job.rej(e); this.pump(w); },
    });
    w.postMessage({ rid, type: job.type, args: job.args });
  }
}
const cores = navigator.hardwareConcurrency || 4;
const pool = new Pool(Math.max(1, Math.min(3, cores - 2)));

// ---------------------------------------------------------------- presets
const currentPreset = () => S.presets.find((p) => p.id === S.presetId) || null;

function swatch(zone) {
  const [r, g, b] = hsvToRgb(zone.hue, Math.min(1, zone.sat / 12), 0.8);
  return `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
}
function presetChips(st) {
  const t = st.tone, z = st.zones;
  return `<div class="chips">
    <span class="chip">median L* ${f1(t.pct[50])}</span>
    <span class="chip">black ${f1(t.pct[1])} · white ${f1(t.pct[99])}</span>
    <span class="chip"><i class="sw" style="background:${swatch(z.shadows)}"></i>shadows</span>
    <span class="chip"><i class="sw" style="background:${swatch(z.highlights)}"></i>highlights</span>
    <span class="chip">chroma ${f1(st.color.meanChroma)}</span></div>`;
}

async function loadPresets() {
  S.presets = await db.listPresets();
  if (!currentPreset() && S.presets[0]) S.presetId = S.presets[0].id;
}

function renderPresets() {
  const v = $('#view-presets');
  v.innerHTML = '';
  if (!S.presets.length) {
    v.append(h(`<div class="empty"><b>No presets yet</b>Pick a photo with the look you want. The app measures its tone and color and saves that as a preset.<br><br><button class="primary" id="newPresetEmpty">New preset from a photo</button></div>`));
    $('#newPresetEmpty').onclick = () => $('#pickRef').click();
    return;
  }
  const list = h('<div class="preset-list"></div>');
  for (const p of S.presets) {
    const el = h(`<div class="preset ${p.id === S.presetId ? 'sel' : ''}">
      <div class="ph"><img src="${p.thumb}" alt=""><div style="min-width:0"><div class="nm">${esc(p.name)}</div>
      <div class="muted small">Default strength ${p.strength}%</div>${presetChips(p.stats)}</div></div>
      <div class="row">
        <button class="primary" data-a="use">Use</button>
        <button data-a="rename">Rename</button>
        <button data-a="dup">Duplicate</button>
        <button data-a="strength">Strength</button>
        <button class="danger" data-a="del">Delete</button>
      </div></div>`);
    el.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      if (a === 'use') { S.presetId = p.id; localStorage.setItem('lm_preset', p.id); setTab('match'); }
      if (a === 'rename') {
        const name = await ask('Rename preset', p.name);
        if (name) { p.name = name; await db.putPreset(p); backupPreset(p); renderPresets(); }
      }
      if (a === 'dup') {
        const c = { ...p, id: uid(), name: `${p.name} copy`, created: Date.now(), driveId: null };
        await db.putPreset(c); backupPreset(c); await loadPresets(); renderPresets();
      }
      if (a === 'strength') {
        const s = await ask('Default match strength (0–100)', String(p.strength), 'number');
        if (s !== null && s !== '') { p.strength = Math.max(0, Math.min(100, Math.round(+s))); await db.putPreset(p); backupPreset(p); renderPresets(); }
      }
      if (a === 'del') {
        if (await confirmSheet(`Delete “${p.name}”?`, 'Photos already exported are not affected.', 'Delete')) {
          await db.deletePreset(p.id);
          if (p.driveId && drive.token()) drive.trash(p.driveId).catch(() => {});
          await loadPresets(); renderPresets();
        }
      }
    };
    list.append(el);
  }
  v.append(list);
}

async function newPresetFrom(file) {
  const sheet = openSheet(`<h2>New preset</h2><img class="big" id="npImg" alt=""><p class="muted small" id="npStatus">Measuring the reference…</p>
    <label class="muted small">Name</label><input type="text" id="npName" value="${esc(baseName(file.name))}">
    <div class="acts"><button class="ghost" data-close>Cancel</button><button class="primary" id="npSave" disabled>Save preset</button></div>`);
  $('#npImg', sheet).src = blobURL(file);
  try {
    const { stats, thumb } = await pool.call(0, 'measureRef', { file }, { priority: true });
    $('#npStatus', sheet).innerHTML = presetChips(stats);
    const btn = $('#npSave', sheet);
    btn.disabled = false;
    btn.onclick = async () => {
      const p = { id: uid(), name: $('#npName', sheet).value.trim() || 'Untitled look', stats, thumb: await blobToDataURL(thumb), strength: 100, created: Date.now() };
      await db.putPreset(p);
      S.presetId = p.id; localStorage.setItem('lm_preset', p.id);
      closeSheet(); await loadPresets(); renderPresets(); backupPreset(p);
      toast(`Saved “${p.name}”`);
    };
  } catch (e) { $('#npStatus', sheet).textContent = `Couldn't read that image: ${e.message}`; }
}

async function backupPreset(p) {
  if (!drive.token()) return;
  try {
    const root = await drive.folder('LookMatch');
    const dir = await drive.folder('presets', root);
    const blob = new Blob([JSON.stringify({ ...p, driveId: undefined })], { type: 'application/json' });
    if (p.driveId) await drive.update(p.driveId, blob);
    else { p.driveId = await drive.upload(blob, `${p.name.replace(/[\\/]/g, '-')}.lookmatch.json`, dir, 'application/json'); await db.putPreset(p); }
  } catch (e) { console.warn('preset backup failed', e); }
}

async function restorePresets() {
  const root = await drive.folder('LookMatch');
  const dir = await drive.folder('presets', root);
  const files = await drive.listJson(dir);
  let n = 0;
  for (const f of files) {
    try {
      const p = JSON.parse(await drive.download(f.id));
      if (!p.stats || !p.id) continue;
      p.driveId = f.id;
      if (!S.presets.find((q) => q.id === p.id)) { await db.putPreset(p); n++; }
    } catch (e) { /* skip */ }
  }
  await loadPresets();
  return n;
}

// ---------------------------------------------------------------- match / batch
function statusLabel(p) {
  return { loading: 'reading', ready: 'queued', solving: 'matching', done: 'matched', error: 'error', exporting: 'exporting', exported: 'exported' }[p.status] || p.status;
}

function renderMatch() {
  const v = $('#view-match');
  const pr = currentPreset();
  v.innerHTML = '';
  if (!S.presets.length) {
    v.append(h(`<div class="empty"><b>Make a preset first</b>Go to Presets and pick a reference photo.</div>`));
    return;
  }
  const pick = h('<div class="pick-preset"></div>');
  for (const p of S.presets) {
    const b = h(`<button class="${p.id === S.presetId ? 'on' : ''}"><img src="${p.thumb}" alt="">${esc(p.name)}</button>`);
    b.onclick = () => {
      if (p.id === S.presetId) return;
      S.presetId = p.id; localStorage.setItem('lm_preset', p.id);
      for (const ph of S.photos) { ph.strength = p.strength; if (ph.status === 'done' || ph.status === 'exported') ph.status = 'ready'; }
      renderMatch(); runQueue();
    };
    pick.append(b);
  }
  v.append(pick);
  const done = S.photos.filter((p) => p.status === 'done' || p.status === 'exported').length;
  const bar = h(`<div class="bar">
    <button class="primary" id="addPhotos">Add photos</button>
    <div class="grow muted small">${S.photos.length ? `${done} of ${S.photos.length} matched to “${esc(pr?.name)}”` : ''}</div>
    ${S.photos.length ? '<button id="exportAll">Export all</button><button class="ghost" id="clearAll">Clear</button>' : ''}
  </div>`);
  v.append(bar);
  if (S.photos.length) v.append(h(`<div class="progress"><i style="width:${(done / S.photos.length) * 100}%"></i></div>`));
  $('#addPhotos', v).onclick = () => $('#pickPhotos').click();
  if ($('#exportAll', v)) $('#exportAll', v).onclick = () => exportPhotos(S.photos.filter((p) => p.params));
  if ($('#clearAll', v)) $('#clearAll', v).onclick = async () => {
    if (!(await confirmSheet('Clear all photos?', 'Unexported edits are lost. Originals are untouched.', 'Clear'))) return;
    for (const p of S.photos) pool.call(p.worker, 'unload', { id: p.id }).catch(() => {});
    S.photos = []; renderMatch();
  };
  if (!S.photos.length) {
    v.append(h(`<div class="empty"><b>Add photos to match</b>Each photo gets its own edit, solved from its own measurements.</div>`));
    return;
  }
  const grid = h('<div class="grid"></div>');
  for (const p of S.photos) {
    const busy = ['loading', 'solving', 'exporting'].includes(p.status);
    const t = h(`<button class="tile" data-id="${p.id}">${p.thumbURL ? `<img src="${p.thumbURL}" alt="">` : ''}
      ${busy ? '<div class="spin"></div>' : ''}<span class="st ${p.status === 'done' || p.status === 'exported' ? 'done' : p.status === 'error' ? 'err' : ''}">${statusLabel(p)}</span></button>`);
    t.onclick = () => { if (p.params) openDetail(p); else if (p.status === 'error') toast(p.error || 'Failed'); };
    grid.append(t);
  }
  v.append(grid);
}

let renderQueued = false;
function rerenderMatchSoon() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; if (S.tab === 'match') renderMatch(); }); }

async function addPhotos(files) {
  const pr = currentPreset();
  for (const file of files) {
    const p = { id: uid(), file, name: file.name || 'photo.jpg', status: 'loading', strength: pr ? pr.strength : 100, worker: pool.assign() };
    S.photos.push(p);
    pool.call(p.worker, 'load', { id: p.id, file }).then((r) => {
      p.thumbURL = blobURL(r.thumb); p.before = r.stats; p.w = r.width; p.h = r.height;
      p.status = 'ready'; rerenderMatchSoon(); runQueue();
    }).catch((e) => { p.status = 'error'; p.error = e.message; rerenderMatchSoon(); });
  }
  setTab('match');
}

function solvePhoto(p, { priority = false } = {}) {
  const pr = currentPreset();
  if (!pr) return Promise.resolve();
  p.status = 'solving'; p.presetId = pr.id; rerenderMatchSoon();
  return pool.call(p.worker, 'solve', { id: p.id, refStats: pr.stats, strength: p.strength / 100 }, { priority }).then((r) => {
    Object.assign(p, { params: r.params, solved: { ...r.params }, targets: r.targets, before: r.before, after: r.after, timings: r.timings, guardScale: r.guardScale, status: 'done' });
    rerenderMatchSoon();
    return r;
  }).catch((e) => { p.status = 'error'; p.error = e.message; rerenderMatchSoon(); });
}

function runQueue() {
  for (const p of S.photos) if (p.status === 'ready') solvePhoto(p);
}

// ---------------------------------------------------------------- detail view
let D = null; // active detail state

function numbersTable(p) {
  const pr = currentPreset();
  const b = p.before, a = p.after, T = p.targets, r = pr?.stats;
  if (!b || !a || !T) return '';
  const toneErr = (s) => PCTS.reduce((acc, q) => acc + Math.abs(s.tone.pct[q] - T.tone.pct[q]), 0) / PCTS.length;
  const wbErr = (s) => Math.hypot(s.wb.a - T.wb.a, s.wb.b - T.wb.b);
  const zs = Object.keys(T.zones);
  const zoneErr = (s) => (zs.length ? zs.reduce((acc, z) => acc + Math.hypot(s.zones[z].a - T.zones[z].a, s.zones[z].b - T.zones[z].b), 0) / zs.length : 0);
  const cls = (bv, av) => (av < bv - 0.05 ? 'good' : av > bv + 0.3 ? 'bad' : '');
  const row = (label, bv, av, rv, better = true) => `<tr><td>${label}</td><td>${bv}</td><td class="${better ? cls(+bv, +av) : ''}">${av}</td><td>${rv}</td></tr>`;
  const newClip = (Math.max(0, a.tone.clipHi - b.tone.clipHi) * 100).toFixed(2) + ' / ' + (Math.max(0, a.tone.clipLo - b.tone.clipLo) * 100).toFixed(2);
  return `<table class="nums"><tr><th></th><th>Before</th><th>After</th><th>Ref / target</th></tr>
    ${row('Median L*', f1(b.tone.pct[50]), f1(a.tone.pct[50]), `${f1(r?.tone.pct[50])} / ${f1(T.tone.pct[50])}`, false)}
    ${row('Black / white (p1 / p99)', `${f1(b.tone.pct[1])} / ${f1(b.tone.pct[99])}`, `${f1(a.tone.pct[1])} / ${f1(a.tone.pct[99])}`, `${f1(T.tone.pct[1])} / ${f1(T.tone.pct[99])}`, false)}
    ${row('Tone curve error (L*)', f1(toneErr(b)), f1(toneErr(a)), '0')}
    ${row('Neutral cast error (Lab)', f1(wbErr(b)), f1(wbErr(a)), '0')}
    ${row('Zone color error (Lab)', f1(zoneErr(b)), f1(zoneErr(a)), '0')}
    ${row('Mean chroma', f1(b.color.meanChroma), f1(a.color.meanChroma), `${f1(r?.color.meanChroma)} / ${f1(T.color.meanChroma)}`, false)}
    ${row('Skin hue° (lit side)', b.skin.frac > 0.005 ? `${f1(b.skin.hue)} (${f1(b.skin.litHue)})` : 'n/a', a.skin.frac > 0.005 ? `${f1(a.skin.hue)} (${f1(a.skin.litHue)})` : 'n/a', '35–64', false)}
    ${row('New clipping hi / lo %', '–', newClip, '≤ 0.10', false)}
  </table>${p.guardScale < 0.99 ? `<p class="muted small">Edit scaled to ${Math.round(p.guardScale * 100)}% to avoid clipping.</p>` : ''}`;
}

function sliderGroups(p) {
  const groups = {};
  for (const s of SLIDERS) (groups[s.group] ||= []).push(s);
  return Object.entries(groups).map(([g, list], gi) => `<details class="group" ${gi < 1 ? 'open' : ''}><summary>${g}</summary>
    ${list.map((s) => {
      const v = p.params[s.key];
      const step = s.step || 1;
      return `<div class="sl ${Math.abs(v) > 1e-9 ? 'changed' : ''}" data-k="${s.key}"><label>${s.label}</label>
        <input type="range" min="${s.ui[0]}" max="${s.ui[1]}" step="${step}" value="${v}">
        <input type="number" min="${s.ui[0]}" max="${s.ui[1]}" step="${step}" value="${step < 1 ? (+v).toFixed(2) : Math.round(v)}"></div>`;
    }).join('')}</details>`).join('');
}

function openDetail(p) {
  const pr = currentPreset();
  const el = $('#detail');
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  el.innerHTML = `<div class="dhead"><button class="ghost" id="dBack">‹ Back</button><div class="nm">${esc(p.name)}</div><button class="primary" id="dExport">Export</button></div>
    <div class="stage" id="stage"><canvas id="cv"></canvas><span class="lbl l" id="lblL">Before</span><span class="lbl r" id="lblR">After</span>
      ${pr ? `<img class="refthumb" src="${pr.thumb}" alt="reference"><span class="reflbl">ref</span>` : ''}</div>
    <div class="dbody">
      <div class="bar" style="margin-top:10px"><div class="seg" id="mode"><button data-m="before">Before</button><button data-m="split" class="on">Split</button><button data-m="after">After</button></div>
        <div class="grow"></div><button id="reMatch">Re-match</button></div>
      <div class="card"><h3>Match strength</h3><div class="strength"><input type="range" id="str" min="0" max="100" step="1" value="${p.strength}"><output id="strOut">${p.strength}%</output></div>
        <p class="muted small" style="margin:6px 0 0">Changing strength re-solves this photo. Preset default: ${pr?.strength ?? 100}%.</p></div>
      <div class="card"><h3>Measurements</h3><div id="nums">${numbersTable(p)}</div></div>
      <div class="card" id="sliders">${sliderGroups(p)}</div>
    </div>`;
  D = { p, mode: 'split', split: 0.5, orig: null, edit: null, busy: false, again: false };
  $('#dBack').onclick = closeDetail;
  $('#dExport').onclick = () => exportPhotos([p]);
  $('#mode').onclick = (e) => { const m = e.target.dataset.m; if (!m) return; D.mode = m; [...$('#mode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === m)); draw(); };
  $('#reMatch').onclick = async () => {
    $('#reMatch').disabled = true; $('#reMatch').textContent = 'Matching…';
    await solvePhoto(p, { priority: true });
    refreshDetail(); $('#reMatch').disabled = false; $('#reMatch').textContent = 'Re-match';
  };
  const str = $('#str');
  str.oninput = () => ($('#strOut').textContent = `${str.value}%`);
  str.onchange = async () => {
    p.strength = +str.value;
    $('#reMatch').disabled = true;
    await solvePhoto(p, { priority: true });
    refreshDetail(); $('#reMatch').disabled = false;
  };
  bindSliders();
  bindStage();
  requestPreview(true);
}

function refreshDetail() {
  if (!D) return;
  $('#nums').innerHTML = numbersTable(D.p);
  const open = [...document.querySelectorAll('#sliders details')].map((d) => d.open);
  $('#sliders').innerHTML = sliderGroups(D.p);
  [...document.querySelectorAll('#sliders details')].forEach((d, i) => (d.open = open[i]));
  bindSliders();
  requestPreview(false);
}

function bindSliders() {
  let measureT;
  document.querySelectorAll('#sliders .sl').forEach((row) => {
    const k = row.dataset.k;
    const [range, num] = row.querySelectorAll('input');
    const set = (v, from) => {
      const s = SLIDERS.find((x) => x.key === k);
      v = Math.max(s.ui[0], Math.min(s.ui[1], +v || 0));
      D.p.params[k] = v;
      if (from !== range) range.value = v;
      if (from !== num) num.value = s.step ? v.toFixed(2) : Math.round(v);
      row.classList.toggle('changed', Math.abs(v) > 1e-9);
      requestPreview(false);
      clearTimeout(measureT);
      measureT = setTimeout(async () => {
        const r = await pool.call(D.p.worker, 'measureParams', { id: D.p.id, params: D.p.params }, { priority: true });
        D.p.after = r.after; $('#nums').innerHTML = numbersTable(D.p);
      }, 350);
    };
    range.oninput = () => set(range.value, range);
    num.onchange = () => set(num.value, num);
    row.querySelector('label').ondblclick = () => set(0);
  });
}

async function requestPreview(withOriginal) {
  if (!D) return;
  if (D.busy) { D.again = true; return; }
  D.busy = true;
  const p = D.p;
  const side = Math.min(1600, Math.round(Math.max(window.innerWidth, 400) * Math.min(2, devicePixelRatio || 1)));
  try {
    const r = await pool.call(p.worker, 'preview', { id: p.id, params: p.params, side, withOriginal: withOriginal || !D.orig }, { priority: true });
    if (!D || D.p !== p) return;
    if (r.original) D.orig = r.original;
    D.edit = r.edited;
    draw();
  } catch (e) { toast(e.message); }
  D.busy = false;
  if (D && D.again) { D.again = false; requestPreview(false); }
}

function draw() {
  if (!D || !D.edit) return;
  const cv = $('#cv');
  const { width: w, height: hgt } = D.edit;
  if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
  const x = cv.getContext('2d');
  const m = D.mode;
  if (m === 'after' || !D.orig) x.drawImage(D.edit, 0, 0);
  else if (m === 'before') x.drawImage(D.orig, 0, 0);
  else {
    const sx = Math.round(w * D.split);
    x.drawImage(D.orig, 0, 0, sx, hgt, 0, 0, sx, hgt);
    x.drawImage(D.edit, sx, 0, w - sx, hgt, sx, 0, w - sx, hgt);
    x.fillStyle = 'rgba(255,255,255,.9)'; x.fillRect(sx - 1, 0, 2, hgt);
  }
  $('#lblL').hidden = m === 'after'; $('#lblR').hidden = m === 'before';
  $('#lblL').textContent = m === 'split' ? 'Before' : 'Before';
}

function bindStage() {
  const st = $('#stage');
  let dragging = false;
  const pos = (e) => { const r = st.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  st.addEventListener('pointerdown', (e) => {
    if (D.mode !== 'split') return;
    dragging = true; st.setPointerCapture(e.pointerId); D.split = pos(e); draw();
  });
  st.addEventListener('pointermove', (e) => { if (dragging) { D.split = pos(e); draw(); } });
  st.addEventListener('pointerup', () => (dragging = false));
  st.addEventListener('pointercancel', () => (dragging = false));
}

function closeDetail() {
  $('#detail').hidden = true; $('#detail').innerHTML = '';
  document.body.style.overflow = '';
  D = null;
  renderMatch();
}

// ---------------------------------------------------------------- export
progressListeners.add((pr) => {
  const el = $('#expStatus');
  if (el && pr.phase) el.dataset.phase = `${pr.phase} ${Math.round(pr.f * 100)}%`;
});

async function exportPhotos(list) {
  list = list.filter((p) => p.params);
  if (!list.length) return toast('Nothing matched yet.');
  const dest = S.settings.dest;
  if (dest === 'drive' && !drive.token()) {
    if (!S.settings.clientId) {
      const ok = await confirmSheet('Google Drive isn’t set up', 'Add your OAuth client ID in Settings, or switch the export destination to “This iPhone”.', 'Open Settings');
      if (ok) { closeDetailIfOpen(); setTab('settings'); }
      return;
    }
    const ok = await confirmSheet('Connect Google Drive first', 'Signing in reloads the page, so photos you added will need to be added again. Connect now, before adding photos next time.', 'Connect');
    if (ok) drive.connect(S.settings.clientId);
    return;
  }
  const pr = currentPreset();
  const sheet = openSheet(`<h2>Exporting ${list.length} photo${list.length > 1 ? 's' : ''}</h2><p id="expStatus" class="muted">Starting…</p>
    <div class="progress"><i id="expBar"></i></div><div id="expActs" class="acts"><button class="ghost" id="expCancel">Stop</button></div>`, { dismissable: false });
  let cancelled = false;
  $('#expCancel', sheet).onclick = () => { cancelled = true; };
  const status = (t) => ($('#expStatus', sheet).textContent = t);
  const bar = (f) => ($('#expBar', sheet).style.width = `${f * 100}%`);
  const wake = await navigator.wakeLock?.request?.('screen').catch(() => null);
  const date = new Date().toISOString().slice(0, 10);
  let doneN = 0;
  const errors = [];
  try {
    if (dest === 'drive') {
      const root = await drive.folder('LookMatch');
      const dir = await drive.folder(`${(pr?.name || 'look').replace(/[\\/]/g, '-')} ${date}`, root);
      for (const p of list) {
        if (cancelled) break;
        status(`${p.name}: rendering full size…`);
        p.status = 'exporting'; rerenderMatchSoon();
        try {
          const r = await pool.call(p.worker, 'export', exportArgs(p));
          status(`${p.name}: uploading…`);
          const b = baseName(p.name);
          await drive.upload(r.jpeg, `${b}_lookmatch.jpg`, dir, 'image/jpeg');
          if (r.lrCopy) await drive.upload(r.lrCopy, `${b}_lightroom.jpg`, dir, 'image/jpeg');
          if (r.xmp) await drive.upload(new Blob([r.xmp], { type: 'application/rdf+xml' }), `${b}_lookmatch.xmp`, dir, 'application/rdf+xml');
          p.status = 'exported';
        } catch (e) { errors.push(`${p.name}: ${e.message}`); p.status = 'done'; if (String(e.message).includes('sign-in')) break; }
        doneN++; bar(doneN / list.length); rerenderMatchSoon();
      }
      status(cancelled ? `Stopped after ${doneN}.` : `Done. ${doneN - errors.length} saved to Drive › LookMatch › ${pr?.name} ${date}.`);
    } else {
      // device: batches of 10 through the share sheet (Save Images / Save to Files)
      for (let i = 0; i < list.length && !cancelled; i += 10) {
        const chunk = list.slice(i, i + 10);
        const files = [];
        for (const p of chunk) {
          if (cancelled) break;
          status(`${p.name}: rendering full size…`);
          p.status = 'exporting'; rerenderMatchSoon();
          try {
            const r = await pool.call(p.worker, 'export', exportArgs(p));
            const b = baseName(p.name);
            files.push(new File([r.jpeg], `${b}_lookmatch.jpg`, { type: 'image/jpeg' }));
            if (r.lrCopy) files.push(new File([r.lrCopy], `${b}_lightroom.jpg`, { type: 'image/jpeg' }));
            if (r.xmp) files.push(new File([r.xmp], `${b}_lookmatch.xmp`, { type: 'application/octet-stream' }));
            p.status = 'exported';
          } catch (e) { errors.push(`${p.name}: ${e.message}`); p.status = 'done'; }
          doneN++; bar(doneN / list.length); rerenderMatchSoon();
        }
        if (!files.length) continue;
        await deliverFiles(files, sheet, i + chunk.length < list.length);
      }
      status(cancelled ? `Stopped after ${doneN}.` : 'Done.');
    }
  } catch (e) { errors.push(e.message); }
  wake?.release?.().catch?.(() => {});
  if (errors.length) status(`${$('#expStatus', sheet).textContent} Problems: ${errors.join(' · ')}`);
  $('#expActs', sheet).innerHTML = '<button class="primary" data-close>Close</button>';
  $('#expActs [data-close]', sheet).onclick = closeSheet;
}

function exportArgs(p) {
  return { id: p.id, params: p.params, quality: S.settings.quality, lightroom: S.settings.lightroom, lrMode: S.settings.lrMode, name: baseName(p.name) };
}

// iOS only allows the share sheet from a tap, so each batch waits for one.
function deliverFiles(files, sheet, more) {
  return new Promise((resolve) => {
    const acts = $('#expActs', sheet);
    const canShare = navigator.canShare && navigator.canShare({ files });
    const imgs = files.filter((f) => f.type === 'image/jpeg');
    acts.innerHTML = '';
    if (canShare) {
      const b = h(`<button class="primary">Save ${imgs.length} photo${imgs.length > 1 ? 's' : ''}${files.length > imgs.length ? ` + ${files.length - imgs.length} file` : ''}</button>`);
      b.onclick = async () => {
        try { await navigator.share({ files }); } catch (e) { /* user cancelled */ }
        resolve();
      };
      acts.append(b);
    } else {
      const wrap = h('<div style="display:flex;flex-direction:column;gap:6px;width:100%"></div>');
      for (const f of files) wrap.append(h(`<a href="${blobURL(f)}" download="${esc(f.name)}" style="color:var(--accent)">${esc(f.name)}</a>`));
      const next = h(`<button class="primary">${more ? 'Next batch' : 'Finish'}</button>`);
      next.onclick = () => resolve();
      acts.append(wrap, next);
    }
  });
}

function closeDetailIfOpen() { if (D) closeDetail(); }

// ---------------------------------------------------------------- settings view
function renderSettings() {
  const v = $('#view-settings');
  const s = S.settings;
  const tok = drive.token();
  v.innerHTML = `<div class="settings">
    <div class="card"><h3>Export</h3>
      <div class="field"><label class="t">Send exports to</label>
        <select id="sDest"><option value="drive">Google Drive</option><option value="device">This iPhone (Photos / Files)</option></select></div>
      <div class="field"><label class="t">JPEG quality</label><input type="number" id="sQ" min="60" max="100" value="${s.quality}"></div>
      <label class="check"><input type="checkbox" id="sLR" ${s.lightroom ? 'checked' : ''}> Also export Lightroom files</label>
      <p class="muted small">For each photo: <code>_lightroom.jpg</code> (your untouched original with the computed settings embedded, so Lightroom opens it already edited) and <code>_lookmatch.xmp</code> (the same settings as a Lightroom preset you can import).</p>
      <div class="field"><label class="t">Lightroom settings style</label>
        <select id="sLRM"><option value="sliders">Basic sliders (easy to tweak, approximate)</option><option value="curve">Tone curve (closer match)</option></select></div>
    </div>
    <div class="card"><h3>Google Drive</h3>
      <p class="small">${tok ? `Connected. Sign-in good for about ${drive.minutesLeft()} more minutes.` : 'Not connected.'}</p>
      <div class="field"><label class="t">OAuth client ID</label><input type="text" id="sCID" placeholder="xxxx.apps.googleusercontent.com" value="${esc(s.clientId)}"></div>
      <div class="bar"><button class="primary" id="sConn" ${s.clientId ? '' : 'disabled'}>${tok ? 'Reconnect' : 'Connect'}</button>
        ${tok ? '<button id="sDisc">Disconnect</button><button id="sBackup">Back up presets</button><button id="sRestore">Restore presets</button>' : ''}</div>
      <p class="muted small">Connect before adding photos. Sign-in reloads the page and lasts an hour. The app only sees files it creates.</p>
      <details><summary class="small">Setting up the client ID</summary><ol class="steps small">
        <li>console.cloud.google.com → your project → APIs &amp; Services → Library → enable <b>Google Drive API</b>.</li>
        <li>OAuth consent screen → External → add yourself as a test user.</li>
        <li>Credentials → Create credentials → OAuth client ID → <b>Web application</b>.</li>
        <li>Authorized JavaScript origin: <code>${esc(location.origin)}</code></li>
        <li>Authorized redirect URI: <code>${esc(drive.redirectUri())}</code></li>
        <li>Paste the client ID above.</li></ol></details>
    </div>
    <div class="card"><h3>About</h3><p class="muted small">Everything runs on this phone. Presets store measured targets, not slider values. Each photo is measured and solved on its own. Workers: ${pool.workers.length}.</p></div>
  </div>`;
  $('#sDest').value = s.dest; $('#sLRM').value = s.lrMode;
  $('#sDest').onchange = (e) => { s.dest = e.target.value; saveSettings(); };
  $('#sQ').onchange = (e) => { s.quality = Math.max(60, Math.min(100, +e.target.value || 92)); saveSettings(); };
  $('#sLR').onchange = (e) => { s.lightroom = e.target.checked; saveSettings(); };
  $('#sLRM').onchange = (e) => { s.lrMode = e.target.value; saveSettings(); };
  $('#sCID').oninput = (e) => { s.clientId = e.target.value.trim(); saveSettings(); $('#sConn').disabled = !s.clientId; };
  $('#sConn').onclick = async () => {
    if (S.photos.length && !(await confirmSheet('Reload to sign in?', 'Photos you added will need to be added again.', 'Continue'))) return;
    drive.connect(s.clientId);
  };
  if ($('#sDisc')) $('#sDisc').onclick = () => { drive.disconnect(); renderSettings(); };
  if ($('#sBackup')) $('#sBackup').onclick = async () => { for (const p of S.presets) await backupPreset(p); toast(`Backed up ${S.presets.length} preset(s) to Drive › LookMatch › presets`); };
  if ($('#sRestore')) $('#sRestore').onclick = async () => { try { const n = await restorePresets(); toast(`Restored ${n} preset(s)`); } catch (e) { toast(e.message); } };
}

// ---------------------------------------------------------------- sheets
function openSheet(inner, { dismissable = true } = {}) {
  const s = $('#sheet');
  s.innerHTML = `<div class="box">${inner}</div>`;
  s.hidden = false;
  s.onclick = (e) => { if (dismissable && (e.target === s || e.target.hasAttribute('data-close'))) closeSheet(); };
  return s;
}
function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; }
function ask(title, value = '', type = 'text') {
  return new Promise((res) => {
    const s = openSheet(`<h2>${esc(title)}</h2><input type="${type}" id="askIn" value="${esc(value)}"><div class="acts"><button class="ghost" id="askNo">Cancel</button><button class="primary" id="askOk">OK</button></div>`, { dismissable: false });
    const inp = $('#askIn', s); inp.focus(); inp.select?.();
    $('#askNo', s).onclick = () => { closeSheet(); res(null); };
    $('#askOk', s).onclick = () => { const v = inp.value.trim(); closeSheet(); res(v); };
  });
}
function confirmSheet(title, body, okLabel = 'OK') {
  return new Promise((res) => {
    const s = openSheet(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><div class="acts"><button class="ghost" id="cNo">Cancel</button><button class="primary" id="cOk">${esc(okLabel)}</button></div>`, { dismissable: false });
    $('#cNo', s).onclick = () => { closeSheet(); res(false); };
    $('#cOk', s).onclick = () => { closeSheet(); res(true); };
  });
}

// ---------------------------------------------------------------- tabs + boot
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  for (const k of ['presets', 'match', 'settings']) $(`#view-${k}`).hidden = k !== t;
  $('#title').textContent = { presets: 'Presets', match: 'Match', settings: 'Settings' }[t];
  const ta = $('#topActions');
  ta.innerHTML = '';
  if (t === 'presets') { const b = h('<button class="primary">+ New</button>'); b.onclick = () => $('#pickRef').click(); ta.append(b); }
  if (t === 'presets') renderPresets();
  if (t === 'match') renderMatch();
  if (t === 'settings') renderSettings();
}

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$('#pickRef').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) newPresetFrom(f); };
$('#pickPhotos').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addPhotos(fs); };

(async function boot() {
  const r = drive.captureRedirect();
  await db.persist();
  await loadPresets();
  if (r?.ok) { toast('Google Drive connected'); setTab('match'); for (const p of S.presets) if (!p.driveId) backupPreset(p); }
  else if (r?.error) { toast(`Drive sign-in failed: ${r.error}`); setTab('settings'); }
  else setTab(S.presets.length ? 'match' : 'presets');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();

// for automated tests
window.__lm = { S, pool, addPhotos, newPresetFrom, exportPhotos, openDetail, solvePhoto };
