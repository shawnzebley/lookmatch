import { SLIDERS, CURVE_SATURATION, defaultParams, compile, LOCAL_SLIDERS, REGIONS, CURVE_KEYS, curveLUT, isIdentityCurve } from './engine/pipeline.js';
import { parsePreset, toParams, unsupported } from './engine/lrpreset.js';
import { FINISH_PROFILES } from './engine/finish.js';
import { srgbToLinear, linearToSrgb } from './engine/color.js';
import { PCTS } from './engine/measure.js';
import { hsvToRgb, wheelHueToAB, abToWheelHue, labToLin } from './engine/color.js';
import { profileSummary } from './engine/style.js';
import { isIdentityGeom, maxRect, towardValid, fitAfterTurn, validRect, geomSize } from './engine/geom.js';
import { SKIN_SMOOTH_DEFAULT, photoToOut } from './engine/retouch.js';
import { groupScenes, keeperScore } from './engine/cull.js';
import * as db from './lib/db.js';
import * as drive from './lib/drive.js';

const APP_VERSION = '2026-10-02a';

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

// ---------------------------------------------------------------- problem log
// Every failure is kept (last 20, this device only) with what's needed to fix it, so a screenshot
// or a pasted "Copy details" says which file, which step and which browser.
const ERR_KEY = 'lm_errors';
function readErrors() { try { return JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch (e) { return []; } }
function logError(step, err, file = null) {
  const rec = {
    at: new Date().toISOString(), step, message: String(err && err.message || err),
    detail: String(err && (err.detail || err.stack) || '').split('\n').slice(0, 6).join('\n'),
    file: file ? { name: file.name, type: file.type || '', mb: +(file.size / 1048576).toFixed(2) } : null,
    ua: navigator.userAgent, app: APP_VERSION,
  };
  try { localStorage.setItem(ERR_KEY, JSON.stringify([rec, ...readErrors()].slice(0, 20))); } catch (e) { /* storage full */ }
  return rec;
}
const errorText = (r) => `LookMatch ${r.app} · ${r.at}\nStep: ${r.step}\n${r.file ? `File: ${r.file.name} (${r.file.type || 'no type'}, ${r.file.mb} MB)\n` : ''}Error: ${r.message}\n${r.detail ? `${r.detail}\n` : ''}Browser: ${r.ua}`;
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Copy failed; take a screenshot instead'); }
}
// The face and people models are a big part of the app. When one can't start on this device, log why (once per reason).
const visionLogged = new Set();
function noteVision(r, file) {
  for (const [what, msg] of [['people finder', r.mask && !r.mask.ok && r.mask.err], ['face finder', r.faceErr]]) {
    if (!msg || visionLogged.has(what + msg)) continue;
    visionLogged.add(what + msg);
    logError(what, new Error(msg), file);
  }
}
function showProblem(title, rec, extraActs = '') {
  const s = openSheet(`<h2>${esc(title)}</h2><p>${esc(rec.message)}</p>
    ${rec.file ? `<p class="muted small">${esc(rec.file.name)} · ${esc(rec.file.type || 'no type')} · ${rec.file.mb} MB</p>` : ''}
    <div class="acts">${extraActs}<button id="pCopy">Copy details</button><button class="primary" data-close>OK</button></div>`);
  $('#pCopy', s).onclick = () => copyText(errorText(rec));
  return s;
}

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'lm_settings';
const S = {
  presets: [],
  settings: { clientId: '243038152226-jfgss8uq68lb72bi9j5jqgkdlg475kj8.apps.googleusercontent.com', quality: 92, lightroom: true, lrMode: 'sliders', dest: 'drive', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') },
  presetId: localStorage.getItem('lm_preset') || null,
  look: (() => { try { return JSON.parse(localStorage.getItem('lm_look') || 'null'); } catch (e) { return null; } })(),
  styleTab: null, autoOpen: false,
  photos: [],
  tab: 'match',
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
      if (m.ok) p.res(m.res); else { const er = new Error(m.error); er.detail = m.stack; p.rej(er); }
    };
    w.onerror = (e) => {
      // an uncaught worker failure (on a phone usually memory): fail the waiting job instead of spinning forever
      console.error('worker error', e);
      e.preventDefault?.();
      const msg = `Photo engine stopped (${e.message || 'probably out of memory'}). Try fewer photos at once.`;
      for (const [, p] of w.pending) p.rej(new Error(msg));
      w.pending.clear();
    };
    return w;
  }
  assign() { const w = this.workers[this.rr++ % this.workers.length]; return w.idx; }
  // one job at a time per worker, keeps memory flat on the phone
  call(idx, type, args, { priority = false } = {}) {
    const w = this.workers[idx];
    return new Promise((res, rej) => {
      if (type === 'solve') {
        const superseded = w.queue.filter((job) => job.type === 'solve' && job.args.id === args.id);
        w.queue = w.queue.filter((job) => !superseded.includes(job));
        for (const job of superseded) job.rej(new Error('A newer look replaced this queued match'));
      }
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
const currentPreset = () => (S.look && S.look.kind === 'preset' ? S.presets.find((p) => p.id === S.look.id) || null : null);

function swatch(zone) {
  const [r, g, b] = hsvToRgb(zone.hue, Math.min(1, zone.sat / 12), 0.8);
  return `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
}
function presetChips(st, pr = null) {
  if (pr?.lr) {
    return `<div class="chips"><span class="chip">Lightroom preset · exact values</span>${pr.unsupported?.length ? `<span class="chip">not applied: ${esc(pr.unsupported.join(', '))}</span>` : ''}</div>`;
  }
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
  // older installs picked a preset before looks existed: keep using it
  if (!S.look && S.presetId && S.presets.find((p) => p.id === S.presetId)) S.look = { kind: 'preset', id: S.presetId };
}

function renderPresets() {
  const v = $('#view-presets');
  v.innerHTML = '';
  if (!S.presets.length) {
    v.append(h(`<div class="empty"><b>No references yet</b>Pick a photo with the look you want, or import a Lightroom preset (.xmp or .lrtemplate) to apply its exact values.<br><br><button class="primary" id="newPresetEmpty">New reference photo</button><br><br><button id="importLREmpty">Import Lightroom preset</button></div>`));
    $('#newPresetEmpty').onclick = () => $('#pickRef').click();
    $('#importLREmpty').onclick = () => $('#pickLR').click();
    return;
  }
  const list = h('<div class="preset-list"></div>');
  for (const p of S.presets) {
    const el = h(`<div class="preset ${S.look && S.look.kind === 'preset' && S.look.id === p.id ? 'sel' : ''}">
      <div class="ph"><img src="${p.thumb}" alt=""><div style="min-width:0"><div class="nm">${esc(p.name)}</div>
      <div class="muted small">Default strength ${p.strength}%</div>${presetChips(p.stats, p)}</div></div>
      <div class="row">
        <button class="primary" data-a="use">Use</button>
        <button data-a="rename">Rename</button>
        <button data-a="dup">Duplicate</button>
        <button data-a="strength">Strength</button>
        <button data-a="finish">Finish: ${esc(FINISH_PROFILES[p.finish || 'off']?.name || 'Off')}</button>
        <button class="danger" data-a="del">Delete</button>
      </div></div>`);
    el.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      if (a === 'use') { S.styleTab = 'preset'; setLook({ kind: 'preset', id: p.id }); setTab('match'); }
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
      if (a === 'finish') {
        const keys = Object.keys(FINISH_PROFILES);
        p.finish = keys[(keys.indexOf(p.finish || 'off') + 1) % keys.length];
        await db.putPreset(p); backupPreset(p); renderPresets();
        for (const ph of S.photos) if (presetOf(ph) === p && !ph.finish && (ph.status === 'done' || ph.status === 'exported')) ph.status = 'ready';
        runQueue();
        toast(`Finish: ${FINISH_PROFILES[p.finish].name}`);
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
  const sheet = openSheet(`<h2>New reference</h2><img class="big" id="npImg" alt=""><p class="muted small" id="npStatus">Measuring the reference…</p>
    <label class="muted small">Name</label><input type="text" id="npName" value="${esc(baseName(file.name))}">
    <div class="acts"><button class="ghost" data-close>Cancel</button><button class="primary" id="npSave" disabled>Save reference</button></div>`);
  const img = $('#npImg', sheet);
  img.onerror = () => { img.hidden = true; }; // HEIF in browsers without it: the measured thumbnail replaces it
  img.src = blobURL(file);
  try {
    const { stats, thumb } = await pool.call(0, 'measureRef', { file }, { priority: true });
    img.hidden = false; img.src = blobURL(thumb);
    $('#npStatus', sheet).innerHTML = presetChips(stats);
    const btn = $('#npSave', sheet);
    btn.disabled = false;
    btn.onclick = async () => {
      const p = { id: uid(), name: $('#npName', sheet).value.trim() || 'Untitled look', stats, thumb: await blobToDataURL(thumb), strength: 100, created: Date.now() };
      await db.putPreset(p);
      closeSheet(); await loadPresets(); renderPresets(); backupPreset(p);
      S.styleTab = 'preset'; setLook({ kind: 'preset', id: p.id });
      if (D && D.p) { D.styleKind = 'preset'; }
      if (S.tab !== 'match' && !D) setTab('match');
      toast(`Saved “${p.name}”`);
    };
  } catch (e) {
    const rec = logError('new preset: read reference', e, file);
    $('#npStatus', sheet).innerHTML = `<span style="color:var(--bad)">Couldn't read that image.</span> ${esc(rec.message)} <button class="lnk" id="npCopy">Copy details</button>`;
    $('#npCopy', sheet).onclick = () => copyText(errorText(rec));
  }
}

// Lightroom presets: exact values; the solver only normalises each photo's exposure and white balance.
function lrThumb(params) {
  // strip: grey ramp on top, then skin, teal, green, blue, red patches, all through the preset
  const W = 160, H = 96, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d'), img = x.createImageData(W, H), f = compile(params), res = new Float32Array(6);
  const patches = [[224, 172, 140], [150, 105, 80], [40, 110, 120], [70, 120, 60], [60, 90, 170], [180, 50, 45], [235, 225, 205], [30, 30, 35]];
  for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
    let rgb;
    if (y < H / 2) { const g = i / (W - 1) * 255; rgb = [g, g, g]; } else rgb = patches[Math.min(7, Math.floor(i / (W / 8)))];
    f(srgbToLinear(rgb[0] / 255), srgbToLinear(rgb[1] / 255), srgbToLinear(rgb[2] / 255), res);
    const o = (y * W + i) * 4;
    img.data[o] = 255 * linearToSrgb(res[0]); img.data[o + 1] = 255 * linearToSrgb(res[1]); img.data[o + 2] = 255 * linearToSrgb(res[2]); img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.85);
}

async function importLightroom(files) {
  let n = 0, last = null;
  for (const file of files) {
    try {
      const { name, settings } = parsePreset(await file.text(), file.name);
      const params = toParams(settings);
      if (!Object.keys(params).length) continue;
      const p = { id: uid(), name: name || baseName(file.name), lr: true, lrParams: params, unsupported: unsupported(settings), stats: null, thumb: lrThumb(params), strength: 100, created: Date.now() };
      await db.putPreset(p); backupPreset(p); n++; last = p;
    } catch (e) { console.warn('preset import failed', file.name, e); }
  }
  await loadPresets(); renderPresets();
  if (last) { S.styleTab = 'preset'; setLook({ kind: 'preset', id: last.id }); }
  toast(n ? `Imported ${n} Lightroom preset${n > 1 ? 's' : ''}` : 'No usable presets in those files');
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
      if ((!p.stats && !p.lr) || !p.id) continue;
      p.driveId = f.id;
      if (!S.presets.find((q) => q.id === p.id)) { await db.putPreset(p); n++; }
    } catch (e) { /* skip */ }
  }
  await loadPresets();
  return n;
}

// ---------------------------------------------------------------- looks
// A look is a photographer's style ({ kind: 'photographer', key }) or a saved reference
// ({ kind: 'preset', id }: a photo's measured look, or an imported Lightroom preset).
// S.look applies to every photo; p.look overrides it for one photo (set in the editor).
const LOOK_KEY = 'lm_look';
const PHOTOGRAPHERS = Object.keys(FINISH_PROFILES).filter((k) => k !== 'off');
const NONE_LOOK = Object.freeze({ kind: 'none' });
const isNoneLook = (l) => l?.kind === 'none';
const presetById = (id) => S.presets.find((q) => q.id === id) || null;
const lookValid = (l) => !!l && (isNoneLook(l) || (l.kind === 'photographer' ? !!FINISH_PROFILES[l.key] : l.kind === 'preset' && !!presetById(l.id)));
const lookOf = (p) => (isNoneLook(p.look) ? NONE_LOOK : lookValid(p.look) ? p.look : isNoneLook(S.look) ? NONE_LOOK : lookValid(S.look) ? S.look : null);
const presetOf = (p) => { const l = lookOf(p); return l && l.kind === 'preset' ? presetById(l.id) : null; };
const lookName = (l) => (!l ? '' : isNoneLook(l) ? 'Plain photo' : l.kind === 'photographer' ? FINISH_PROFILES[l.key].name : presetById(l.id)?.name || 'reference');
const sameLook = (a, b) => !!a && !!b && a.kind === b.kind && (isNoneLook(a) || (a.key || a.id) === (b.key || b.id));
// photographer finish in effect for a photo: the photographer itself, or the one added on top of a reference
const finishKeyOf = (p) => { const l = lookOf(p); if (!l || isNoneLook(l)) return 'off'; return l.kind === 'photographer' ? l.key : p.finish || presetById(l.id)?.finish || 'off'; };

function resetPhotoLook(p) {
  cancelPhotoSolve(p);
  const retained = keptEdits(p.params);
  p.params = { ...defaultParams(), ...retained };
  p.solved = null; p.solvedLook = NONE_LOOK; p.finish = undefined; p.finishStrength = undefined; p.strength = 100;
  p.style = null; p.regions = null; p.targets = null; p.after = null; p.loss = null; p.model = null;
  delete p.error; delete p.errRec;
  if (p.before) p.status = 'done';
  return Object.keys(retained).length > 0;
}

function setPhotoNone(p) {
  const editing = D?.p === p;
  if (editing) commitEdit();
  const before = editing ? editSnap(p) : null;
  p.look = NONE_LOOK;
  const hasKeptEdits = resetPhotoLook(p);
  if (editing) {
    D.styleKind = null;
    D.userEdited = hasKeptEdits;
    recordLookResetUndo(before);
    refreshDetail();
  }
  runQueue(); rerenderMatchSoon();
}

function setLook(l) {
  S.look = l;
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(l)); } catch (e) { /* private mode */ }
  if (isNoneLook(l)) {
    const activePhoto = D?.p && S.photos.includes(D.p) ? D.p : null;
    if (activePhoto) commitEdit();
    const activeBefore = activePhoto ? editSnap(activePhoto) : null;
    for (const ph of S.photos) { ph.look = null; resetPhotoLook(ph); }
    if (S.photos.length === 1) S.autoOpen = true;
    if (activePhoto && D?.p === activePhoto) { D.styleKind = null; D.userEdited = Object.keys(keptEdits(D.p.params)).length > 0; recordLookResetUndo(activeBefore); refreshDetail(); }
    runQueue(); renderMatch();
    return;
  }
  if (l.kind === 'preset') { S.presetId = l.id; localStorage.setItem('lm_preset', l.id); }
  const pr = l.kind === 'preset' ? presetById(l.id) : null;
  for (const ph of S.photos) {
    ph.look = null; ph.finish = undefined; ph.strength = pr ? pr.strength : 100;
    if (['done', 'exported', 'ready'].includes(ph.status)) ph.status = 'ready';
  }
  if (S.photos.length === 1) S.autoOpen = true;
  runQueue(); renderMatch();
}

// plain-words summary of a photographer's published work (medians of the measured set)
function describePhotographer(key) {
  const f = FINISH_PROFILES[key];
  const s = profileSummary(f.data) || { p50: null, p1: f.p1, p99: f.p99, chroma: f.chroma, sh: f.sh, hi: f.hi };
  const tone = (ab) => (!ab || ab[1] == null ? null : ab[1] > 5.5 ? 'warm' : ab[1] < 1.5 ? 'cool' : 'neutral');
  const bits = [];
  if (s.p50 != null) bits.push(s.p50 < 28 ? 'low-key' : s.p50 > 50 ? 'bright' : 'mid-key');
  bits.push(s.p1 < 2.5 ? 'deep blacks' : s.p1 > 5.5 ? 'matte blacks' : 'firm blacks');
  bits.push(s.p99 < 82 ? 'dim highlights' : s.p99 < 90 ? 'soft highlights' : 'clean whites');
  bits.push(s.chroma < 12 ? 'muted colour' : s.chroma > 16 ? 'rich colour' : 'natural colour');
  if (tone(s.sh)) bits.push(`${tone(s.sh)} shadows`);
  if (tone(s.hi) && tone(s.hi) !== tone(s.sh)) bits.push(`${tone(s.hi)} highlights`);
  if (s.sep != null && s.sep >= 4) bits.push('subject lit above the background');
  if (s.logC != null && s.logC >= 0.25) bits.push('colourful subject, quieter background');
  if ((f.vignette || 0) <= -25) bits.push('vignette');
  return { text: bits.join(' · '), s };
}
// three dots: the photographer's shadow, midtone and highlight colour (chroma doubled so it reads at dot size)
function toneDots(s) {
  const dot = (L, ab) => {
    if (!ab || ab[0] == null) return '';
    const o = [0, 0, 0]; labToLin(L, ab[0] * 2, ab[1] * 2, o);
    const c = o.map((v) => Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, v)))));
    return `<i style="background:rgb(${c.join(',')})"></i>`;
  };
  return `<span class="dots">${dot(22, s.sh)}${dot(50, s.mid)}${dot(80, s.hi)}</span>`;
}

// ---------------------------------------------------------------- edit view: 1 photos, 2 style
function statusLabel(p) {
  if (p.status === 'loading' && p.phase === 'heif') return 'converting HEIF';
  if (isNoneLook(lookOf(p))) return p.params ? 'edit' : 'open to edit';
  if (p.params && !lookOf(p)) return 'edit';
  if (p.status === 'ready' && !lookOf(p)) return 'open to edit';
  return { loading: 'reading', ready: 'queued', solving: 'styling', done: 'done', error: 'error', exporting: 'exporting', exported: 'exported' }[p.status] || p.status;
}

// Narrative-style dots: top = eyes (green open, red closed), bottom = focus (green 8+, amber 5-8, red under 5)
function cullDots(c) {
  if (!c) return '';
  const eye = c.eyes ? `<i class="${c.eyes === 'open' ? 'ok' : 'bad'}" title="Eyes ${c.eyes}"></i>` : '<i class="none"></i>';
  const f = c.focus == null ? '<i class="none"></i>' : `<i class="${c.focus >= 8 ? 'ok' : c.focus >= 5 ? 'mid' : 'bad'}" title="Focus ${c.focus.toFixed(1)} / 10"></i>`;
  return `<span class="cdots">${eye}${f}</span>`;
}
const isKeeper = (p) => p.cull && p.cull.eyes !== 'closed' && (p.cull.focus == null || p.cull.focus >= 8);

function photoTile(p) {
  const busy = ['loading', 'solving', 'exporting'].includes(p.status);
  const t = h(`<button class="tile ${p.picked ? 'picked' : ''}" data-id="${p.id}">${p.thumbURL ? `<img src="${p.thumbURL}" alt="">` : ''}${cullDots(p.cull)}${p.picked ? '<span class="pick">★</span>' : ''}
    ${busy ? '<div class="spin"></div>' : ''}${p.loss && p.loss.worst !== 'ok' && !busy ? `<span class="wbadge ${p.loss.worst}" title="${esc(p.loss.issues.map((i) => i.text).join(', '))}">!</span>` : ''}<span class="st ${p.status === 'done' || p.status === 'exported' ? 'done' : p.status === 'error' ? 'err' : ''}">${statusLabel(p)}</span></button>`);
  t.onclick = () => {
    if (p.params || (p.status === 'ready' && (!lookOf(p) || isNoneLook(lookOf(p))))) return openDetail(p);
    if (p.status !== 'error') { if (!lookOf(p)) $('#stepStyle')?.scrollIntoView({ behavior: 'smooth' }); return; }
    const s = showProblem(`Couldn't use ${p.name}`, p.errRec || logError('photo', p.error, p.file), '<button class="danger" id="pRemove">Remove</button>');
    $('#pRemove', s).onclick = () => { pool.call(p.worker, 'unload', { id: p.id }).catch(() => {}); S.photos = S.photos.filter((q) => q !== p); closeSheet(); renderMatch(); };
  };
  return t;
}

// ---------------------------------------------------------------- culling
// Scenes = runs of near-identical frames (in the order picked). Filters narrow what the strip shows and
// what Export all sends. "Pick the best of each scene" stars the frame with eyes open and the best focus.
function sceneOf() {
  const key = S.photos.map((p) => p.id + (p.cull ? '+' : '-')).join(',');
  if (S.scenesKey !== key) {
    const withSig = S.photos.filter((p) => p.cull && p.cull.sig);
    const g = groupScenes(withSig.map((p) => p.cull.sig));
    S.scenes = new Map(withSig.map((p, i) => [p, g[i]]));
    S.scenesKey = key;
  }
  return S.scenes;
}
function visiblePhotos() {
  const f = S.cullFilter || 'all';
  if (f === 'picks') return S.photos.filter((p) => p.picked);
  if (f === 'keepers') return S.photos.filter(isKeeper);
  return S.photos;
}
function cullBar() {
  const f = S.cullFilter || 'all', n = S.photos.length;
  const np = S.photos.filter((p) => p.picked).length, nk = S.photos.filter(isKeeper).length;
  const nScenes = new Set(sceneOf().values()).size;
  const bar = h(`<div class="cullbar"><div class="chips-row" id="cullF">
      <button data-f="all" class="${f === 'all' ? 'on' : ''}">All ${n}</button>
      <button data-f="keepers" class="${f === 'keepers' ? 'on' : ''}">Eyes open, sharp ${nk}</button>
      <button data-f="picks" class="${f === 'picks' ? 'on' : ''}">★ Picks ${np}</button></div>
    <div class="row" style="margin-top:6px"><button class="small" id="cullBest">★ Best of each scene${nScenes > 1 ? ` (${nScenes})` : ''}</button>${np ? '<button class="ghost small" id="cullClear">Clear picks</button>' : ''}</div>
    <p class="muted small" style="margin:4px 0 0">Dots on each photo: top = eyes (red closed), bottom = focus (green 8+ of 10). Star a photo in its editor.</p></div>`);
  $('#cullF', bar).onclick = (e) => { const v = e.target.closest('button')?.dataset.f; if (!v) return; S.cullFilter = v; renderMatch(); setTopActions(); };
  $('#cullBest', bar).onclick = () => {
    const best = new Map();
    for (const [p, g] of sceneOf()) { const b = best.get(g); if (!b || keeperScore(p.cull) > keeperScore(b.cull)) best.set(g, p); }
    for (const p of best.values()) p.picked = true;
    toast(`Starred ${best.size} photo${best.size > 1 ? 's' : ''}`, 2000);
    renderMatch(); setTopActions();
  };
  if ($('#cullClear', bar)) $('#cullClear', bar).onclick = () => { for (const p of S.photos) p.picked = false; renderMatch(); setTopActions(); };
  return bar;
}

function photographerCards(current, onPick) {
  const list = h('<div class="pcards"></div>');
  for (const k of PHOTOGRAPHERS) {
    const f = FINISH_PROFILES[k], { text, s } = describePhotographer(k);
    const on = current && current.kind === 'photographer' && current.key === k;
    const b = h(`<button class="pcard ${on ? 'on' : ''}"><div class="pc-top"><b>${esc(f.name)}</b>${toneDots(s)}</div>
      <div class="pc-desc">${esc(text)}</div><div class="pc-src muted">${s.n || f.n} published photos · ${esc(f.source)}</div></button>`);
    b.onclick = () => onPick({ kind: 'photographer', key: k });
    list.append(b);
  }
  return list;
}

function referenceCards(current, onPick) {
  const wrap = h('<div></div>');
  if (S.presets.length) {
    const list = h('<div class="rcards"></div>');
    for (const pr of S.presets) {
      const on = current && current.kind === 'preset' && current.id === pr.id;
      const b = h(`<button class="rcard ${on ? 'on' : ''}"><img src="${pr.thumb}" alt=""><span>${esc(pr.name)}</span>${pr.lr ? '<em>Lightroom</em>' : ''}</button>`);
      b.onclick = () => onPick({ kind: 'preset', id: pr.id });
      list.append(b);
    }
    wrap.append(list);
  } else {
    wrap.append(h('<p class="muted small" style="margin:4px 0 10px">Pick a photo whose look you want. Each of your photos gets its own edit toward it.</p>'));
  }
  const acts = h(`<div class="row wrap"><button class="primary" data-a="ref">+ Reference photo</button><button data-a="lr">Import Lightroom preset</button>${S.presets.length ? '<button class="ghost" data-a="manage">Manage</button>' : ''}</div>`);
  acts.onclick = (e) => {
    const a = e.target.dataset.a;
    if (a === 'ref') $('#pickRef').click();
    if (a === 'lr') $('#pickLR').click();
    if (a === 'manage') { closeDetailIfOpen(); setTab('presets'); }
  };
  wrap.append(acts);
  return wrap;
}

function renderMatch() {
  const v = $('#view-match');
  if (!v) return;
  v.innerHTML = '';
  const look = lookValid(S.look) ? S.look : null;
  const total = S.photos.length;
  const done = S.photos.filter((p) => p.status === 'done' || p.status === 'exported').length;

  // 1. photos
  const photos = h(`<section class="step"><div class="step-h"><span class="n">1</span><h2>Photos</h2><div class="grow"></div>
    ${total ? '<button class="ghost small" id="clearAll">Clear</button>' : ''}</div></section>`);
  if (!total) {
    photos.append(h(`<button class="pickbig" id="addPhotos"><span class="plus">+</span><b>Select photos</b><span class="muted small">One or a batch · JPEG, HEIC, HIF</span></button>`));
  } else {
    const strip = h('<div class="strip"></div>');
    strip.append(h('<button class="tile add" id="addPhotos" aria-label="Add photos"><span>+</span></button>'));
    const shown = visiblePhotos(), scenes = sceneOf();
    let last = -1;
    for (const p of shown) {
      const sc = scenes.get(p);
      if (total > 1 && sc !== last && S.photos.length > 2) strip.append(h(`<span class="scene">${sc + 1}</span>`));
      last = sc;
      strip.append(photoTile(p));
    }
    photos.append(strip);
    if (total > 1) photos.append(cullBar());
    const line = isNoneLook(look) ? 'Plain photo selected. Tap a photo to edit.'
      : !look ? 'Tap a photo to edit without a reference, or pick a style below.'
        : done < total ? `Styling like ${esc(lookName(look))}… ${done} of ${total}`
        : `${total === 1 ? 'Done.' : `All ${total} done.`} Tap a photo to fine-tune, crop or export.`;
    photos.append(h(`<p class="muted small step-note">${line}</p>`));
    if (look && !isNoneLook(look) && done < total) photos.append(h(`<div class="progress"><i style="width:${(done / total) * 100}%"></i></div>`));
  }
  v.append(photos);
  $('#addPhotos', v).onclick = () => $('#pickPhotos').click();
  if ($('#clearAll', v)) $('#clearAll', v).onclick = async () => {
    if (!(await confirmSheet('Clear all photos?', 'Unexported edits are lost. Originals are untouched.', 'Clear'))) return;
    for (const p of S.photos) pool.call(p.worker, 'unload', { id: p.id }).catch(() => {});
    S.photos = []; renderMatch(); setTab('match');
  };

  // 2. style
  const kind = S.styleTab || look?.kind || 'photographer';
  const style = h(`<section class="step ${total && !look ? 'attention' : ''}" id="stepStyle"><div class="step-h"><span class="n">2</span><h2>Style</h2>
      <div class="grow"></div>${look ? `<span class="muted small">Using ${esc(lookName(look))}</span>` : ''}</div>
    <div class="seg wide" id="styleSeg"><button data-k="photographer" class="${kind === 'photographer' ? 'on' : ''}">Photographer</button><button data-k="preset" class="${kind === 'preset' ? 'on' : ''}">Reference photo</button><button data-k="none" class="${isNoneLook(look) ? 'on' : ''}">None</button></div>
    <p class="muted small step-note">${isNoneLook(look) ? 'Use the photo as it was captured.' : kind === 'photographer' ? 'What that photographer would do to each of your photos, read from the published shots most like each scene.' : 'Copy the look of one photo onto yours. Your saved references and Lightroom presets are here.'}</p>
    </section>`);
  const pick = (l) => { if (!sameLook(l, S.look)) setLook(l); };
  if (kind !== 'none') style.append(kind === 'photographer' ? photographerCards(look, pick) : referenceCards(look, pick));
  $('#styleSeg', style).onclick = (e) => {
    const k = e.target.dataset.k; if (!k) return;
    if (k === 'none') { S.styleTab = 'none'; if (!isNoneLook(S.look)) setLook(NONE_LOOK); else renderMatch(); return; }
    S.styleTab = k; renderMatch();
  };
  v.append(style);
  setTopActions();
}

let renderQueued = false;
function rerenderMatchSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (S.tab !== 'match') return;
    // keep the page where it was: only the photo strip and status line change while styling
    const y = window.scrollY, sx = $('#view-match .strip')?.scrollLeft || 0;
    renderMatch();
    window.scrollTo(0, y);
    const st = $('#view-match .strip'); if (st) st.scrollLeft = sx;
  });
}

async function addPhotos(files) {
  const look = lookValid(S.look) ? S.look : null;
  const pr = look && look.kind === 'preset' ? presetById(look.id) : null;
  if (!S.photos.length && files.length === 1) S.autoOpen = true;
  for (const file of files) {
    const p = { id: uid(), file, name: file.name || 'photo.jpg', status: 'loading', strength: pr ? pr.strength : 100, worker: pool.assign() };
    S.photos.push(p);
    pool.call(p.worker, 'load', { id: p.id, file }).then((r) => {
      p.thumbURL = blobURL(r.thumb); p.before = r.stats; p.w = r.width; p.h = r.height; p.converted = r.converted; p.mask = r.mask; p.faceErr = r.faceErr; p.cull = r.cull; S.scenesKey = null; noteVision(r, file);
      p.status = 'ready'; rerenderMatchSoon();
      if (isNoneLook(lookOf(p))) { p.params = defaultParams(); p.status = 'done'; }
      if (S.autoOpen && S.photos.length === 1 && (!lookOf(p) || isNoneLook(lookOf(p))) && !D && S.tab === 'match') {
        S.autoOpen = false; p.params ||= defaultParams(); openDetail(p);
      } else runQueue();
    }).catch((e) => { p.status = 'error'; p.error = e.message; p.errRec = logError('add photo: read', e, file); rerenderMatchSoon(); });
  }
  setTab('match');
}

function solveArgs(p) {
  const look = lookOf(p);
  if (!look || isNoneLook(look)) return null;
  const finishStrength = (p.finishStrength ?? 100) / 100;
  const split = p.split !== false;
  if (look.kind === 'photographer') return { refStats: null, lrParams: {}, strength: 1, finish: look.key, finishStrength, pull: 0.25, split };
  const pr = presetById(look.id);
  const assist = S.settings.modelUrl && !pr.lr && pr.thumb;
  return { refStats: pr.stats, lrParams: pr.lr ? pr.lrParams : null, strength: p.strength / 100, finish: p.finish || pr.finish || 'off', finishStrength, split, ...(assist ? { modelUrl: S.settings.modelUrl, refThumb: pr.thumb } : {}) };
}

// References saved before subject/background existed: measure the split once from the saved thumbnail.
const upgrading = new Map();
function ensurePresetRegions(pr) {
  const stats = pr?.stats;
  const current = stats?.matchVersion === 3 && Number.isFinite(stats.signature?.halation);
  if (!pr || pr.lr || !pr.stats || current || !pr.thumb) return Promise.resolve();
  if (!upgrading.has(pr.id)) {
    upgrading.set(pr.id, (async () => {
      try {
        const r = await pool.call(0, 'measureRef', { file: await dataURLToBlob(pr.thumb) }, { priority: true });
        pr.stats.regions = r.stats.regions || null; pr.stats.signature = r.stats.signature || { halation: 0 };
        pr.stats.maskedRegions = r.stats.maskedRegions; pr.stats.skinMatch = r.stats.skinMatch; pr.stats.matchVersion = 3;
      } catch (e) { pr.stats.regions = null; pr.stats.signature ||= { halation: 0 }; }
      try { await db.putPreset(pr); } catch (e) { /* stays in memory */ }
    })());
  }
  return upgrading.get(pr.id);
}

// hand edits the style doesn't solve: they survive Redo and a style change
const KEEP_KEYS = ['skinTexture', 'skinClarity', 'skinTone', 'heals', 'points'];
const keptEdits = (params) => Object.fromEntries(KEEP_KEYS.filter((k) => params && params[k] != null).map((k) => [k, structuredClone(params[k])]));

const solveRuns = new WeakMap();
function cancelPhotoSolve(p) {
  solveRuns.set(p, (solveRuns.get(p) || 0) + 1);
  const w = pool.workers[p.worker];
  if (!w) return;
  const stale = w.queue.filter((job) => job.type === 'solve' && job.args.id === p.id);
  if (!stale.length) return;
  w.queue = w.queue.filter((job) => !stale.includes(job));
  for (const job of stale) job.rej(new Error('Plain photo selected; queued style cancelled'));
}
function solvePhoto(p, { priority = false } = {}) {
  if (!solveArgs(p)) return Promise.resolve();
  const run = (solveRuns.get(p) || 0) + 1; solveRuns.set(p, run);
  const look = lookOf(p);
  p.status = 'solving'; p.solvedLook = look; rerenderMatchSoon();
  return ensurePresetRegions(presetOf(p)).then(() => solveRuns.get(p) === run ? pool.call(p.worker, 'solve', { id: p.id, ...solveArgs(p) }, { priority }) : null).then((r) => {
    if (!r || solveRuns.get(p) !== run) return null;
    Object.assign(r.params, keptEdits(p.params));
    if (r.model && !r.model.ok) toast(`Model assist failed, matched without it: ${r.model.error}`);
    Object.assign(p, { params: r.params, solved: structuredClone(r.params), targets: r.targets, before: r.before, after: r.after, loss: r.loss, scene: r.scene, timings: r.timings, guardScale: r.guardScale, model: r.model, style: r.style, regions: r.regions, mask: r.mask || p.mask, status: 'done' });
    rerenderMatchSoon();
    // one photo in, style picked: go straight to the editor
    if (S.autoOpen && S.photos.length === 1 && !D && S.tab === 'match') { S.autoOpen = false; openDetail(p); }
    // restyled in the background while its editor is open (style changed for all photos)
    else if (!priority && D && D.p === p && !D.crop) { D.userEdited = false; refreshDetail(); }
    return r;
  }).catch((e) => { if (solveRuns.get(p) !== run) return null; p.status = 'error'; p.error = e.message; p.errRec = logError('style photo', e, p.file); rerenderMatchSoon(); });
}

function runQueue() {
  for (const p of S.photos) if (p.status === 'ready') {
    if (isNoneLook(lookOf(p))) { p.params ||= defaultParams(); p.status = 'done'; }
    else if (solveArgs(p)) solvePhoto(p);
  }
}

function skinTargetRows(p) {
  const match = p.params?.skinMatch;
  if (match?.version !== 2) return '';
  const values = (z) => z ? `${f1(z.L)} / ${f1(z.a)} / ${f1(z.b)}` : '–';
  const swatch = (z) => {
    if (!z) return '';
    const rgb = labToLin(z.L, z.a, z.b, [0, 0, 0]).map((v) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255));
    return `<span style="display:inline-block;width:12px;height:12px;margin-right:4px;background:rgb(${rgb.join(',')})"></span>`;
  };
  return match.people.flatMap((person) => person.zones.map((zone) => {
    const after = p.after?.skinMatch?.people?.find((q) => q.id === person.id)?.zones?.[zone.name];
    return `<tr><td>Person ${person.id} ${esc({ shadow: 'shadow', midtone: 'midtone', lit: 'lit skin' }[zone.name])} (L* / a* / b*)</td><td>${values(zone.before)}</td><td>${swatch(after)}${values(after)}</td><td>${swatch(zone.target)}${values(zone.target)} (reference ${person.referenceId})</td></tr>`;
  })).join('');
}

// ---------------------------------------------------------------- detail view
let D = null; // active detail state

function numbersTable(p) {
  const pr = presetOf(p);
  const b = p.before, a = p.after, T = p.targets, r = pr?.stats;
  if (!b || !a) return '';
  if (!T) {
    // photographer looks and Lightroom presets have no single reference to measure against
    const st = p.style, row2 = (label, bv, av, tv = '') => `<tr><td>${label}</td><td>${bv}</td><td>${av}</td><td>${tv}</td></tr>`;
    const newClip2 = (Math.max(0, a.tone.clipHi - b.tone.clipHi) * 100).toFixed(2) + ' / ' + (Math.max(0, a.tone.clipLo - b.tone.clipLo) * 100).toFixed(2);
    return `<table class="nums"><tr><th></th><th>Before</th><th>After</th><th>${st ? 'Theirs' : ''}</th></tr>
      ${row2('Median L*', f1(b.tone.pct[50]), f1(a.tone.pct[50]))}
      ${row2('Black / white (p1 / p99)', `${f1(b.tone.pct[1])} / ${f1(b.tone.pct[99])}`, `${f1(a.tone.pct[1])} / ${f1(a.tone.pct[99])}`, st ? `${f1(st.target.p1)} / ${f1(st.target.p99)}` : '')}
      ${row2('Mean chroma', f1(b.color.meanChroma), f1(a.color.meanChroma), st ? f1(st.target.chroma) : '')}
      ${row2('Skin hue° (lit side)', b.skin.frac > 0.005 ? `${f1(b.skin.hue)} (${f1(b.skin.litHue)})` : 'n/a', a.skin.frac > 0.005 ? `${f1(a.skin.hue)} (${f1(a.skin.litHue)})` : 'n/a', '35–64')}
      ${row2('New clipping hi / lo %', '–', newClip2, '≤ 0.10')}${regionRows(p)}</table>`;
  }
  const toneErr = (s) => PCTS.reduce((acc, q) => acc + Math.abs(s.tone.pct[q] - T.tone.pct[q]), 0) / PCTS.length;
  const wbErr = (s) => Math.hypot(s.wb.a - T.wb.a, s.wb.b - T.wb.b);
  const zs = Object.keys(T.zones);
  const zoneErr = (s) => (zs.length ? zs.reduce((acc, z) => acc + Math.hypot(s.zones[z].a - T.zones[z].a, s.zones[z].b - T.zones[z].b), 0) / zs.length : 0);
  const cls = (bv, av) => (av < bv - 0.05 ? 'good' : av > bv + 0.3 ? 'bad' : '');
  const row = (label, bv, av, rv, better = true) => `<tr><td>${label}</td><td>${bv}</td><td class="${better ? cls(+bv, +av) : ''}">${av}</td><td>${rv}</td></tr>`;
  const newClip = (Math.max(0, a.tone.clipHi - b.tone.clipHi) * 100).toFixed(2) + ' / ' + (Math.max(0, a.tone.clipLo - b.tone.clipLo) * 100).toFixed(2);
  const sc = p.scene;
  const sceneLine = `<p class="muted small" style="margin:0 0 8px">${sc ? `Scene: <b>${esc(sc.label)}</b> · EV ${sc.ev.toFixed(1)} · ISO ${sc.iso} · ${esc(sc.shutter)} · f/${sc.aperture}${sc.flash ? ' · flash' : ''}` : 'No camera settings in this file; brightness judged from the image.'}
    <br>Skin guard: ${b.skin.source === 'faces' ? `${b.skin.faces} face${b.skin.faces === 1 ? '' : 's'} found` : 'no faces found, using skin-colored areas'}</p>`;
  return `${sceneLine}<table class="nums"><tr><th></th><th>Before</th><th>After</th><th>Ref / target</th></tr>
    ${row('Median L*', f1(b.tone.pct[50]), f1(a.tone.pct[50]), `${f1(r?.tone.pct[50])} / ${f1(T.tone.pct[50])}`, false)}
    ${row('Black / white (p1 / p99)', `${f1(b.tone.pct[1])} / ${f1(b.tone.pct[99])}`, `${f1(a.tone.pct[1])} / ${f1(a.tone.pct[99])}`, `${f1(T.tone.pct[1])} / ${f1(T.tone.pct[99])}`, false)}
    ${row('Tone curve error (L*)', f1(toneErr(b)), f1(toneErr(a)), '0')}
    ${row('Neutral cast error (Lab)', f1(wbErr(b)), f1(wbErr(a)), '0')}
    ${row('Zone color error (Lab)', f1(zoneErr(b)), f1(zoneErr(a)), '0')}
    ${row('Mean chroma', f1(b.color.meanChroma), f1(a.color.meanChroma), `${f1(r?.color.meanChroma)} / ${f1(T.color.meanChroma)}`, false)}
    ${a.skinMatch && r?.skinMatch ? row('Skin brightness L*', f1(b.skinMatch?.L), f1(a.skinMatch.L), f1(r.skinMatch.L), false) : ''}
    ${a.skinMatch && r?.skinMatch ? row('Skin color a* / b*', `${f1(b.skinMatch?.a)} / ${f1(b.skinMatch?.b)}`, `${f1(a.skinMatch.a)} / ${f1(a.skinMatch.b)}`, `${f1(r.skinMatch.a)} / ${f1(r.skinMatch.b)}`, false) : ''}
    ${skinTargetRows(p)}
    ${row('Skin hue° (lit side)', b.skin.frac > 0.005 ? `${f1(b.skin.hue)} (${f1(b.skin.litHue)})` : 'n/a', a.skin.frac > 0.005 ? `${f1(a.skin.hue)} (${f1(a.skin.litHue)})` : 'n/a', '35–64', false)}
    ${row('New clipping hi / lo %', '–', newClip, '≤ 0.10', false)}${regionRows(p)}
  </table>${p.guardScale < 0.99 ? `<p class="muted small">Edit scaled to ${Math.round(p.guardScale * 100)}% to avoid clipping.</p>` : ''}`;
}

function sliderRow(s, v, baseline = 0) {
  const step = s.step || 1;
  return `<div class="sl ${Math.abs(v - baseline) > 1e-9 ? 'changed' : ''}" data-k="${s.key}"><label>${s.label}</label>
    <input type="range" min="${s.ui[0]}" max="${s.ui[1]}" step="${step}" value="${v}">
    <input type="number" min="${s.ui[0]}" max="${s.ui[1]}" step="${step}" value="${step < 1 ? (+v).toFixed(2) : Math.round(v)}"></div>`;
}

// Lightroom-style master and RGB tone curves. Local curves are applied after the whole-photo curve,
// through the current subject/background mask.
const CURVE_CHANNELS = [
  ['curve', 'Master', '#f3f1eb'], ['curveR', 'Red', '#ff7d73'],
  ['curveG', 'Green', '#83d69b'], ['curveB', 'Blue', '#77b9ff'],
];
const IDENTITY_CURVE = [[0, 0], [255, 255]];
const CURVE_GRID = [0, 64, 128, 192, 255];
function snapCurveCoord(v) { return CURVE_GRID.reduce((best, q) => Math.abs(q - v) < Math.abs(best - v) ? q : best, CURVE_GRID[0]); }
function currentCurvePoints(key = D.curveChannel) {
  return D.region === 'all' ? D.p.params[key] || IDENTITY_CURVE : localOf(D.p, D.region)[key] || IDENTITY_CURVE;
}
function curveValueAt(points, value) {
  const lut = curveLUT(points, 256);
  return lut[Math.max(0, Math.min(255, Math.round(value)))] * 255;
}
function curvePath(points) {
  const lut = curveLUT(points, 256);
  return Array.from(lut, (v, i) => `${i ? 'L' : 'M'}${i} ${255 - v * 255}`).join(' ');
}
function curveCardMarkup(p) {
  const local = D.region !== 'all';
  const points = currentCurvePoints();
  const color = CURVE_CHANNELS.find(([k]) => k === D.curveChannel)?.[2] || '#f3f1eb';
  const grid = CURVE_GRID.map((v) => `<path d="M${v} 0V255 M0 ${v}H255"/>`).join('');
  const dots = points.map(([x, y], i) => `<circle class="curve-dot" data-i="${i}" cx="${x}" cy="${255 - y}" r="4.5" tabindex="0" aria-label="Curve point ${i + 1}: input ${x}, output ${y}; use arrow keys to adjust"/>`).join('');
  const target = local ? (D.region === 'subject' ? 'Subject mask' : 'Background mask') : 'Whole photo';
  const status = D.tool === 'curve' ? 'Tap a tone in the photo to place a control point.' : 'Tap the graph to add a point, or pick a tone from the photo.';
  const localCurves = local ? `<div id="curveAmountRow">${sliderRow({ key: 'curveAmount', label: 'Mask curve amount', ui: [0, 100] }, localOf(p, D.region).curveAmount ?? 100)}</div>` : '';
  const curveSat = sliderRow(CURVE_SATURATION, p.params.curveSaturation ?? 100, 100);
  const regionalReference = p.regions?.referenceStyle?.regionCurves;
  const fittedReferenceCurve = local
    ? localOf(p, D.region).curveAuto === 'reference'
    : p.params.curveAuto === 'reference';
  const curveMatchNote = !local && regionalReference
    ? '<p class="muted small" style="margin:5px 0 0">Reference light and RGB curves are fitted separately. Choose Subject or Background to view and refine them.</p>'
    : fittedReferenceCurve
    ? `<p class="muted small" style="margin:5px 0 0">Fitted from this photo and the selected reference. ${isIdentityCurve(points) ? 'No visible point-curve adjustment was needed.' : 'Adjust the points to refine the match.'}</p>` : '';
  const notes = [];
  if (local && CURVE_KEYS.some((k) => !isIdentityCurve(localOf(p, D.region)[k]))) notes.push('Local curves are baked into the exported photo. Lightroom sidecars do not store local tone curves yet.');
  const anyCurve = CURVE_KEYS.some((k) => !isIdentityCurve(p.params[k])) || REGIONS.some((r) => CURVE_KEYS.some((k) => !isIdentityCurve(localOf(p, r)[k])));
  if (anyCurve && Math.abs((p.params.curveSaturation ?? 100) - 100) > 1e-9) notes.push('Curve saturation compensation is baked into rendered exports; Lightroom XMP has no equivalent setting.');
  const exportNote = notes.map((note) => `<p class="muted small" style="margin:5px 0 0">${note}</p>`).join('');
  const copyMaster = D.curveChannel === 'curve' ? '<button id="curveCopyRGB">Copy Master to RGB</button>' : '';
  return `<h3>Tone curve · ${target}</h3>
    <div class="seg curve-channels" id="curveChannels">${CURVE_CHANNELS.map(([k, label]) => `<button data-c="${k}" class="${D.curveChannel === k ? 'on' : ''}">${label}</button>`).join('')}</div>
    <svg class="curve-graph" id="curveGraph" viewBox="0 0 255 255" role="group" aria-label="${target} ${CURVE_CHANNELS.find(([k]) => k === D.curveChannel)?.[1]} tone curve" style="--curve-color:${color}">
      <g class="curve-grid">${grid}</g><path class="curve-diagonal" d="M0 255L255 0"/><path class="curve-line" d="${curvePath(points)}"/>${dots}
    </svg>
    <div class="row curve-actions"><button id="curvePick" class="${D.tool === 'curve' ? 'on' : ''}">Pick from photo</button><button id="curveS">Gentle S</button>${copyMaster}<button id="curveReset">Reset</button></div>
    <label class="chk"><input type="checkbox" id="curveSnap" ${D.curveSnap ? 'checked' : ''}>Snap points to grid (right-click graph to toggle)</label>
    <div id="curveSaturationRow">${curveSat}</div>
    <p class="muted small" style="margin:4px 0 0">At 100, curve color response is unchanged. 0 removes its chroma change; 200 doubles it. Separate HSL hue, saturation, and luminance sliders are in the Light controls.</p>
    ${curveMatchNote}${localCurves}<p class="muted small" id="curveHelp" style="margin:5px 0 0">${status} Left to right is shadows to highlights; move up to brighten and down to darken. Use Exposure for overall brightness and curves for style. RGB channels add or remove color. Arrow keys nudge a focused point (Shift = 5).</p>${exportNote}`;
}
function drawCurve(focusIndex = null) {
  const svg = $('#curveGraph');
  if (!svg || !D) return;
  const pts = currentCurvePoints();
  svg.querySelector('.curve-line').setAttribute('d', curvePath(pts));
  svg.querySelectorAll('.curve-dot').forEach((dot) => dot.remove());
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i], dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'curve-dot'); dot.dataset.i = String(i); dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(255 - y)); dot.setAttribute('r', '4.5'); dot.setAttribute('tabindex', '0');
    dot.setAttribute('aria-label', `Curve point ${i + 1}: input ${x}, output ${y}; use arrow keys to adjust`); svg.append(dot);
  }
  if (focusIndex != null) svg.querySelector(`.curve-dot[data-i="${focusIndex}"]`)?.focus();
}
function writeCurvePoints(points, focusIndex = null) {
  points.sort((a, b) => a[0] - b[0]);
  const p = D.p.params;
  if (D.region === 'all' && D.curveChannel === 'curve') delete p.curveAuto;
  if (D.region === 'all') p[D.curveChannel] = points;
  else {
    p.local ||= {};
    const loc = { ...(p.local[D.region] || {}), [D.curveChannel]: points };
    if (D.curveChannel === 'curve') delete loc.curveAuto;
    p.local[D.region] = loc;
  }
  D.userEdited = true;
  drawCurve(focusIndex); requestPreview(false); scheduleMeasure();
}
function renderCurveCard() {
  if (!D || !$('#curveCard')) return;
  const box = $('#curveCard'); box.innerHTML = curveCardMarkup(D.p);
  $('#curveChannels', box).onclick = (e) => {
    const key = e.target.closest('button')?.dataset.c;
    if (!key) return;
    D.curveChannel = key; renderCurveCard();
  };
  $('#curvePick', box).onclick = () => setTool(D.tool === 'curve' ? null : 'curve');
  $('#curveS', box).onclick = () => writeCurvePoints([[0, 0], [64, 54], [128, 128], [192, 201], [255, 255]]);
  if ($('#curveCopyRGB', box)) $('#curveCopyRGB', box).onclick = () => {
    const points = currentCurvePoints('curve').map((q) => [...q]);
    if (D.region === 'all') for (const key of ['curveR', 'curveG', 'curveB']) D.p.params[key] = points.map((q) => [...q]);
    else {
      D.p.params.local ||= {};
      D.p.params.local[D.region] = { ...(D.p.params.local[D.region] || {}), ...Object.fromEntries(['curveR', 'curveG', 'curveB'].map((key) => [key, points.map((q) => [...q])])) };
    }
    D.userEdited = true; renderCurveCard(); requestPreview(false); scheduleMeasure(); toast('Master curve copied to RGB');
  };
  $('#curveReset', box).onclick = () => {
    if (D.region === 'all' && D.curveChannel === 'curve') delete D.p.params.curveAuto;
    if (D.region === 'all') delete D.p.params[D.curveChannel];
    else if (D.p.params.local && D.p.params.local[D.region]) {
      delete D.p.params.local[D.region][D.curveChannel];
      if (D.curveChannel === 'curve') delete D.p.params.local[D.region].curveAuto;
    }
    D.userEdited = true; renderCurveCard(); requestPreview(false); scheduleMeasure();
  };
  if ($('#curveAmountRow', box)) bindRows(box.querySelectorAll('#curveAmountRow .sl'), (_k, value) => {
    D.p.params.local ||= {};
    D.p.params.local[D.region] = { ...(D.p.params.local[D.region] || {}), curveAmount: value };
    D.userEdited = true; requestPreview(false); scheduleMeasure();
  });
  bindRows(box.querySelectorAll('#curveSaturationRow .sl'), (_k, value) => {
    D.p.params.curveSaturation = value;
    D.userEdited = true; requestPreview(false); scheduleMeasure();
  }, 100);
  $('#curveSnap', box).onchange = (e) => { D.curveSnap = e.target.checked; };
  const svg = $('#curveGraph', box);
  const xy = (e) => {
    const r = svg.getBoundingClientRect();
    return [Math.max(0, Math.min(255, (e.clientX - r.left) / r.width * 255)), Math.max(0, Math.min(255, 255 - (e.clientY - r.top) / r.height * 255))];
  };
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault(); D.curveSnap = !D.curveSnap;
    $('#curveSnap', box).checked = D.curveSnap; toast(`Curve grid snap ${D.curveSnap ? 'on' : 'off'}`, 1600);
  });
  svg.addEventListener('keydown', (e) => {
    const dot = e.target.closest('.curve-dot');
    if (!dot) return;
    const i = +dot.dataset.i, points = currentCurvePoints().map((q) => [...q]), step = e.shiftKey ? 5 : 1;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const [x0, y0] = points[i];
    const xMin = i === 0 ? 0 : points[i - 1][0] + 2, xMax = i === points.length - 1 ? 255 : points[i + 1][0] - 2;
    const yMin = i === 0 ? 0 : points[i - 1][1], yMax = i === points.length - 1 ? 255 : points[i + 1][1];
    const x = Math.round(Math.max(xMin, Math.min(xMax, x0 + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0))));
    const y = Math.round(Math.max(yMin, Math.min(yMax, y0 + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0))));
    points[i] = [x, y]; writeCurvePoints(points, i);
  });
  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    e.preventDefault(); svg.setPointerCapture(e.pointerId);
    const dot = e.target.closest('.curve-dot');
    if (dot) { dot.focus(); D.curveDrag = +dot.dataset.i; return; }
    let [x, y] = xy(e); const points = currentCurvePoints().map((q) => [...q]);
    if (D.curveSnap) { x = snapCurveCoord(x); y = snapCurveCoord(y); }
    const xi = Math.round(x);
    if (points.some(([px]) => Math.abs(px - xi) < 3)) return;
    points.push([xi, Math.round(D.curveSnap ? y : curveValueAt(points, xi))]); points.sort((a, b) => a[0] - b[0]);
    writeCurvePoints(points, points.findIndex(([px]) => px === xi));
  });
  svg.addEventListener('pointermove', (e) => {
    if (D.curveDrag == null) return;
    const points = currentCurvePoints().map((q) => [...q]), i = D.curveDrag, [rawX, rawY] = xy(e);
    const snappedX = D.curveSnap ? snapCurveCoord(rawX) : rawX, snappedY = D.curveSnap ? snapCurveCoord(rawY) : rawY;
    const x = i === 0 ? 0 : i === points.length - 1 ? 255 : Math.round(Math.max(points[i - 1][0] + 2, Math.min(points[i + 1][0] - 2, snappedX)));
    const lo = i === 0 ? 0 : points[i - 1][1], hi = i === points.length - 1 ? 255 : points[i + 1][1];
    points[i] = [x, Math.round(Math.max(lo, Math.min(hi, snappedY)))];
    writeCurvePoints(points, i);
  });
  const endDrag = () => { D.curveDrag = null; };
  svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
}

// colour grading lives on the wheels card; everything else stays in the slider groups
function sliderGroups(p) {
  if (D && D.region !== 'all') return localGroups(p, D.region);
  const groups = {};
  for (const s of SLIDERS) if (s.group !== 'Color grading') (groups[s.group] ||= []).push(s);
  return Object.entries(groups).map(([g, list], gi) => `<details class="group" ${gi < 1 ? 'open' : ''}><summary>${g}</summary>
    ${list.map((s) => sliderRow(s, p.params[s.key])).join('')}</details>`).join('');
}

// ---------------------------------------------------------------- colour wheels
const WHEELS = [['shadow', 'Shadows'], ['midtone', 'Midtones'], ['highlight', 'Highlights']];
const SLIDER_BY = Object.fromEntries(SLIDERS.map((s) => [s.key, s]));
// saturation on the wheel runs out from the centre on a square-root scale, so the usual 5-30 range is easy to see and grab
const satToR = (s) => Math.sqrt(Math.max(0, Math.min(100, s)) / 100);
const rToSat = (r) => Math.min(100, 100 * r * r);

function gradeCard(p) {
  const local = D && D.region !== 'all';
  return `<div class="wheels">${WHEELS.map(([z, label]) => `<div class="wh" data-z="${z}" data-keys="${z}Hue ${z}Sat">
      <div class="wheel"><canvas></canvas></div><div class="wl">${label}</div><div class="wv muted small"></div></div>`).join('')}</div>
    ${local ? `<p class="muted small" style="margin:4px 0 0">Added on top of the whole-photo grade, ${D.region === 'subject' ? 'on the subject only' : 'on the background only'}. Double-tap a wheel to clear it.</p>`
    : `${sliderRow(SLIDER_BY.gradeBalance, p.params.gradeBalance)}
    <p class="muted small" style="margin:4px 0 0">Drag a dot to grade. Double-tap a wheel to clear it.${p.style && p.style.wheels ? ' The faint dot is where the match left it; the line is what the finishing touch added.' : ''}</p>`}`;
}

// ---------------------------------------------------------------- subject / background
// Values the sliders and wheels show: the whole photo's, or the region's local amounts.
const localOf = (p, r) => (p.params.local && p.params.local[r]) || {};
const editVals = () => (D.region === 'all' ? D.p.params : localOf(D.p, D.region));
function setVal(k, v) {
  const P = D.p.params;
  if (D.region === 'all') { P[k] = v; return; }
  const loc = { subject: {}, background: {}, ...(P.local || {}) };
  loc[D.region] = { ...loc[D.region], [k]: v };
  P.local = loc;
}

function localGroups(p, r) {
  const loc = localOf(p, r), groups = {};
  for (const s of LOCAL_SLIDERS) (groups[s.group] ||= []).push(s);
  return `<p class="muted small" style="margin:0 0 6px">${r === 'subject' ? 'Subject only' : 'Background only'}: added on top of the whole-photo sliders.</p>`
    + Object.entries(groups).map(([g, list]) => `<details class="group" open><summary>${g}</summary>${list.map((s) => sliderRow(s, loc[s.key] || 0)).join('')}</details>`).join('');
}

const signed = (v, d = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
function regionRows(p) {
  const g = p.regions;
  if (!g) return '';
  return `<tr><td>Subject vs background L*</td><td>${signed(g.before.sep, 1)}</td><td>${signed(g.after.sep, 1)}</td><td>${signed(g.theirs.sep, 1)}</td></tr>
    <tr><td>Subject / background color</td><td>${g.before.chroma.toFixed(2)}×</td><td>${g.after.chroma.toFixed(2)}×</td><td>${g.theirs.chroma.toFixed(2)}×</td></tr>`;
}

// what the style did to the subject against the background, in words
function regionNote(p) {
  const g = p.regions;
  if (!g) return '';
  const li = [], b = g.before, a = g.after;
  const d = a.sep - b.sep;
  if (Math.abs(d) >= 1) li.push(`Subject ${d > 0 ? 'lifted' : 'lowered'} against the background: ${signed(b.sep, 1)} → ${signed(a.sep, 1)} L*`);
  const warm = (a.dB - b.dB) + 0.3 * (a.dA - b.dA);
  if (Math.abs(warm) >= 1) li.push(`Subject ${warm > 0 ? 'warmer' : 'cooler'} than the background`);
  if (Math.abs(a.chroma - b.chroma) >= 0.05) li.push(`Subject color ${a.chroma > b.chroma ? 'stronger' : 'weaker'} than the background: ${b.chroma.toFixed(2)}× → ${a.chroma.toFixed(2)}×`);
  if (g.referenceStyle) {
    li.push(g.referenceStyle.regionCurves ? 'Reference fit: separate subject and background light and RGB curves' : 'Reference fit: subject white balance and tonal curve');
    if (g.referenceStyle.backgroundHslBands.length) li.push(`Background HSL matched in ${g.referenceStyle.backgroundHslBands.join(', ')}`);
    if (p.params.halation > 0) li.push(`Warm halation from the reference’s light sources: ${p.params.halation}%`);
  }
  if (!li.length) li.push('Subject and background already sit the way the style does');
  const L = g.local, part = (r) => LOCAL_SLIDERS.filter((s) => L[r][s.key]).map((s) => `${s.label.toLowerCase()} ${s.key === 'exposure' ? signed(L[r][s.key], 2) : signed(L[r][s.key])}`).join(', ');
  const moves = REGIONS.map((r) => (part(r) ? `${r === 'subject' ? 'Subject' : 'Background'}: ${part(r)}` : '')).filter(Boolean).join(' · ');
  const f = g.from || {};
  const basis = f.kind === 'photographer' ? `From the ${f.k} of ${f.n} published ${esc(f.name)} photos with a person in them that are closest to this one.` : 'From the reference photo\'s own subject and background.';
  return `<div class="style"><ul>${li.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>${moves ? `<p class="muted small">${esc(moves)}</p>` : ''}<p class="muted small">${basis}</p></div>`;
}

function regionCard(p) {
  const M = p.mask, R = D.region;
  const tabs = [['all', 'Whole photo'], ['subject', 'Subject'], ['background', 'Background']];
  const seg = `<div class="seg wide3" id="rSeg">${tabs.map(([k, l]) => `<button data-r="${k}" class="${R === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (!M) return `<h3>Subject and background</h3>${seg}<p class="muted small">Finding the subject…</p>`;
  const found = M.frac >= 0.0005, taps = M.picks ? `${M.picks} tap${M.picks > 1 ? 's' : ''}` : '';
  const status = D.pick ? `Tap the photo on what to ${D.pick === 'add' ? 'add to' : 'take out of'} the subject. Tap ${D.pick === 'add' ? '+ Add' : '− Remove'} again when done.`
    : found ? `Subject is ${Math.max(1, Math.round(M.frac * 100))}% of the photo (${[M.people && M.useAuto ? 'people found automatically' : '', taps].filter(Boolean).join(', ')}).`
    : !M.ok ? `The people finder didn't load${M.err ? `: ${esc(M.err.slice(0, 200))}` : ''}. Tap + Add, then the subject, or try again.`
    : M.people ? 'People turned off. Tap + Add, then the subject.' : 'No people found. Tap + Add, then the subject.';
  return `<h3>Subject and background</h3>${seg}
    <div class="mtools"><button id="mAdd" class="${D.pick === 'add' ? 'on' : ''}">+ Add</button><button id="mRem" class="${D.pick === 'remove' ? 'on' : ''}" ${found ? '' : 'disabled'}>− Remove</button><button id="mUndo" ${M.picks ? '' : 'disabled'}>Undo</button><div class="grow"></div><button id="mShow" class="${D.showMask ? 'on' : ''}" ${found ? '' : 'disabled'}>Show</button></div>
    <p class="muted small" style="margin:6px 0 0">${status}</p>
    ${M.ok ? '' : '<div class="mtools"><button id="mRetry">Try again</button></div>'}
    <p class="muted small" style="margin:4px 0 0">To edit a sky or another object, use + Add and tap it. Turn off people detection first if you want only that object in the mask.</p>
    ${M.people ? `<label class="chk"><input type="checkbox" id="mAuto" ${M.useAuto ? 'checked' : ''}> People count as the subject</label>` : ''}
    <label class="chk"><input type="checkbox" id="mSplit" ${p.split !== false ? 'checked' : ''}> Style sets the subject apart from the background</label>
    ${p.split !== false ? regionNote(p) : ''}`;
}

function renderRegionCard() {
  if (!D) return;
  const p = D.p, box = $('#regionCard');
  box.innerHTML = regionCard(p);
  $('#rSeg', box).onclick = (e) => {
    const r = e.target.dataset.r;
    if (!r || r === D.region) return;
    D.region = r;
    renderRegionCard();
    rebuildControls();
    // show where the region is for a moment
    if (r !== 'all' && !D.showMask) { D.flash = true; clearTimeout(D.flashT); D.flashT = setTimeout(() => { if (D) { D.flash = false; requestPreview(false); } }, 1300); }
    requestPreview(false);
  };
  const M = p.mask;
  if (!M) return;
  const pick = (mode) => { D.pick = D.pick === mode ? null : mode; if (D.pick && D.tool) setTool(null); renderRegionCard(); requestPreview(false); };
  $('#mAdd', box).onclick = () => pick('add');
  $('#mRem', box).onclick = () => pick('remove');
  $('#mUndo', box).onclick = () => maskOp({ op: 'undo' });
  if ($('#mRetry', box)) $('#mRetry', box).onclick = () => maskOp({ op: 'retry' });
  $('#mShow', box).onclick = () => { D.showMask = !D.showMask; renderRegionCard(); requestPreview(false); };
  if ($('#mAuto', box)) $('#mAuto', box).onchange = (e) => maskOp({ op: 'auto', on: e.target.checked });
  $('#mSplit', box).onchange = async (e) => {
    p.split = e.target.checked;
    renderRegionCard();
    await solvePhoto(p, { priority: true });
    if (D && D.p === p) { D.userEdited = false; refreshDetail(); }
  };
}

// ---------------------------------------------------------------- retouch: skin + heal
// Skin: a People mask on facial + body skin with Texture and Clarity turned down a little (-8 to -10 reads
// as retouched without looking waxy), plus a skin-only saturation slider (tanned <-> paler) that leaves the
// background alone. Heal: tap a spot; 100% removes it, 50-60% softens creases and under-eye bags.
const SKIN_SLIDERS = [
  { key: 'skinTexture', label: 'Texture', ui: [-100, 100] },
  { key: 'skinClarity', label: 'Clarity', ui: [-100, 100] },
  { key: 'skinTone', label: 'Paler ↔ Tanned', ui: [-100, 100] },
];
const HEAL_KINDS = [['Spot', 1], ['Crease', 0.6]];

function retouchCard(p) {
  const P = p.params, M = p.mask, skin = M && M.skin >= 0.0005;
  const smooth = !!(P.skinTexture || P.skinClarity);
  const heals = P.heals || [], sel = heals[D.healSel];
  const tool = D.tool;
  const skinPart = !M ? '<p class="muted small">Looking for skin…</p>'
    : M && !M.ok ? '<p class="muted small">Skin needs the people finder, which didn\'t load on this device. See Subject and background above.</p>'
    : !skin ? '<p class="muted small">No skin found, so skin smoothing and skin tone are off for this photo.</p>'
    : `<label class="chk"><input type="checkbox" id="skOn" ${smooth ? 'checked' : ''}> Smooth skin (faces and bodies only)</label>
      <div id="skSl">${SKIN_SLIDERS.map((s) => sliderRow(s, P[s.key] || 0)).join('')}</div>
      <p class="muted small" style="margin:4px 0 0">Keep Texture and Clarity near −10. Much lower and skin looks waxy. Skin tone only touches skin, not the background.</p>`;
  const status = tool === 'heal' ? 'Tap a blemish or crease. Tap Heal again when done.'
    : tool === 'source' ? 'Tap where the spot should copy from. Below the spot usually works best.'
    : heals.length ? `${heals.length} spot${heals.length > 1 ? 's' : ''} healed.` : 'No spots healed.';
  const matchedPeople = P.skinMatch?.version === 2 ? P.skinMatch.people.length : 0;
  const skinTargets = !skin || !presetOf(p)?.stats?.skinMatch ? '' : `<p class="muted small">${matchedPeople ? `Reference skin targets: ${matchedPeople} person${matchedPeople === 1 ? '' : 's'}, paired by position. Shadow, midtone and lit-skin values are in More → Measurements.` : 'No confident person pairing for reference skin matching.'}${M?.peopleFaceFallbacks ? ' Missed body poses use facial skin only.' : ''} Unassigned skin is excluded.</p>`;
  return `<h3>Retouch</h3>${skinPart}${skinTargets}
    <div class="mtools"><button id="hlOn" class="${tool === 'heal' ? 'on' : ''}">Heal</button><button id="hlSrc" class="${tool === 'source' ? 'on' : ''}" ${sel ? '' : 'disabled'}>Move source</button><button id="hlUndo" ${heals.length ? '' : 'disabled'}>Undo</button><div class="grow"></div><button id="hlClear" ${heals.length ? '' : 'disabled'}>Clear</button></div>
    <p class="muted small" style="margin:6px 0 0">${status}</p>
    <div class="chips-row" id="hlKind">${HEAL_KINDS.map(([l, v]) => `<button data-o="${v}" class="${Math.abs(D.healOp - v) < 1e-6 ? 'on' : ''}">${l} ${Math.round(v * 100)}%</button>`).join('')}</div>
    <div id="hlSl">${sliderRow({ key: 'hlSize', label: 'Spot size', ui: [0.4, 6], step: 0.1 }, +(D.healSize * 100).toFixed(1))}
    ${sliderRow({ key: 'hlOp', label: sel ? 'Opacity (this spot)' : 'Opacity', ui: [0, 100] }, Math.round((sel ? sel.op : D.healOp) * 100))}</div>`;
}

function renderRetouchCard() {
  if (!D) return;
  const p = D.p, box = $('#retouchCard');
  box.innerHTML = retouchCard(p);
  const P = p.params;
  const after = () => { D.userEdited = true; requestPreview(false); scheduleMeasure(); };
  if ($('#skOn', box)) $('#skOn', box).onchange = (e) => {
    Object.assign(P, e.target.checked ? SKIN_SMOOTH_DEFAULT : { skinTexture: 0, skinClarity: 0 });
    renderRetouchCard(); after();
  };
  bindRows(box.querySelectorAll('#skSl .sl'), (k, v) => { P[k] = v; const on = !!(P.skinTexture || P.skinClarity); if ($('#skOn', box)) $('#skOn', box).checked = on; after(); });
  bindRows(box.querySelectorAll('#hlSl .sl'), (k, v) => {
    if (k === 'hlSize') { D.healSize = v / 100; const h = (P.heals || [])[D.healSel]; if (h) { h.r = D.healSize; after(); } draw(); return; }
    const h = (P.heals || [])[D.healSel];
    if (h) { h.op = v / 100; after(); } else D.healOp = v / 100;
  });
  $('#hlKind', box).onclick = (e) => {
    const o = e.target.closest('button')?.dataset.o;
    if (o == null) return;
    D.healOp = +o;
    const h = (P.heals || [])[D.healSel];
    if (h) { h.op = +o; after(); }
    renderRetouchCard();
  };
  $('#hlOn', box).onclick = () => { setTool(D.tool === 'heal' ? null : 'heal'); };
  $('#hlSrc', box).onclick = () => { setTool(D.tool === 'source' ? null : 'source'); };
  $('#hlUndo', box).onclick = () => { (P.heals || []).pop(); D.healSel = (P.heals || []).length - 1; renderRetouchCard(); after(); draw(); };
  $('#hlClear', box).onclick = () => { P.heals = []; D.healSel = -1; setTool(null); after(); };
}

// slider rows outside #sliders: range + number kept in step, onSet(key, value)
function bindRows(rows, onSet, baseline = 0) {
  rows.forEach((row) => {
    const k = row.dataset.k;
    const [range, num] = row.querySelectorAll('input');
    const lo = +range.min, hi = +range.max, step = +range.step || 1;
    const set = (v, from) => {
      v = Math.max(lo, Math.min(hi, +v || 0));
      if (from !== range) range.value = v;
      if (from !== num) num.value = step < 1 ? v.toFixed(1) : Math.round(v);
      row.classList.toggle('changed', Math.abs(v - baseline) > 1e-9);
      onSet(k, v);
    };
    range.oninput = () => set(range.value, range);
    num.onchange = () => set(num.value, num);
  });
}

// tap tools on the photo: 'heal', 'source', 'point'. Taps edit instead of moving the split line.
function setTool(t) {
  D.tool = t;
  if (t) { D.pick = null; if (D.mode === 'before') { D.mode = 'after'; [...$('#mode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === 'after')); } }
  renderRetouchCard();
  renderRegionCard();
  renderPointCard();
  renderCurveCard();
  draw();
}

async function toolTap(x, y) {
  const p = D.p, P = p.params;
  if (D.tool === 'heal') {
    // tapping an existing spot selects it
    const hit = healHit(x, y);
    if (hit >= 0) { D.healSel = hit; renderRetouchCard(); draw(); return; }
    try {
      const r = await pool.call(p.worker, 'heal', { id: p.id, op: 'add', x, y, size: D.healSize, opacity: D.healOp, side: previewSide() }, { priority: true });
      if (!D || D.p !== p) return;
      (P.heals ||= []).push(r.heal);
      D.healSel = P.heals.length - 1;
      D.userEdited = true;
      renderRetouchCard(); requestPreview(false); scheduleMeasure();
    } catch (e) { toast(e.message, 3000); }
  } else if (D.tool === 'source') {
    const h = (P.heals || [])[D.healSel];
    if (!h) return;
    try {
      const r = await pool.call(p.worker, 'heal', { id: p.id, op: 'source', x, y, heal: h }, { priority: true });
      if (!D || D.p !== p) return;
      P.heals[D.healSel] = r.heal;
      D.userEdited = true;
      setTool('heal'); requestPreview(false);
    } catch (e) { toast(e.message, 3000); }
  } else if (D.tool === 'point') pointTap(x, y);
  else if (D.tool === 'curve') curveTap(x, y);
}

// heal spots in canvas px
function healsOnCanvas(cv) {
  const p = D.p, P = p.params;
  if (!P.heals || !P.heals.length || !p.w) return [];
  const g = p.geom && !isIdentityGeom(p.geom) ? p.geom : null;
  const k = cv.width / geomSize(p.w, p.h, g)[0], L = Math.max(p.w, p.h);
  const T = photoToOut(p.w, p.h, g, k);
  return P.heals.map((h) => { const [cx, cy] = T(h.x * p.w, h.y * p.h), [sx, sy] = T(h.sx * p.w, h.sy * p.h); return { cx, cy, sx, sy, r: h.r * L * k }; });
}
function healHit(x, y) {
  const cv = $('#cv'), X = x * cv.width, Y = y * cv.height;
  return healsOnCanvas(cv).findIndex((s) => Math.hypot(X - s.cx, Y - s.cy) < s.r);
}
function drawHeals(x, cv) {
  if (D.tool !== 'heal' && D.tool !== 'source') return;
  const lw = Math.max(1.5, cv.width / 500);
  healsOnCanvas(cv).forEach((s, i) => {
    const on = i === D.healSel;
    x.lineWidth = lw;
    x.strokeStyle = on ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.55)';
    x.beginPath(); x.arc(s.cx, s.cy, s.r, 0, 2 * Math.PI); x.stroke();
    if (on) {
      x.setLineDash([lw * 3, lw * 3]);
      x.beginPath(); x.arc(s.sx, s.sy, s.r, 0, 2 * Math.PI); x.stroke();
      x.beginPath(); x.moveTo(s.cx, s.cy); x.lineTo(s.sx, s.sy); x.stroke();
      x.setLineDash([]);
    }
  });
}

// ---------------------------------------------------------------- point colour
// Tap a colour (jeans, sky, skin) and move just that colour: hue, saturation, luminance. Range sets how
// close a colour has to be to count. Like the Color Mixer's Point Color, similar colours elsewhere move too.
const POINT_SLIDERS = [
  { key: 'hue', label: 'Hue', ui: [-100, 100] },
  { key: 'sat', label: 'Saturation', ui: [-100, 100] },
  { key: 'lum', label: 'Luminance', ui: [-100, 100] },
  { key: 'range', label: 'Range', ui: [0, 100] },
];
const labCss = (q) => { const o = labToLin(q.L, q.a, q.b, [0, 0, 0]) || [0, 0, 0]; return `rgb(${[0, 1, 2].map((i) => Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, o[i]))))).join(',')})`; };

function renderPointCard() {
  if (!D) return;
  const P = D.p.params, pts = P.points || [], sel = pts[D.pointSel];
  const box = $('#pointCard');
  box.innerHTML = `<h3>Point color</h3>
    <div class="mtools"><button id="ptPick" class="${D.tool === 'point' ? 'on' : ''}">Pick a color</button><div class="grow"></div><button id="ptDel" ${sel ? '' : 'disabled'}>Remove</button></div>
    <p class="muted small" style="margin:6px 0 0">${D.tool === 'point' ? 'Tap the color to change on the photo.' : pts.length ? 'Similar colors elsewhere in the photo move too. Keep it light.' : 'Pick a color on the photo, then move just that color.'}</p>
    ${pts.length ? `<div class="chips-row" id="ptList">${pts.map((q, i) => `<button data-i="${i}" class="${i === D.pointSel ? 'on' : ''}"><span class="sw" style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${labCss(q)}"></span>${i + 1}</button>`).join('')}</div>` : ''}
    ${sel ? `<div id="ptSl">${POINT_SLIDERS.map((s) => sliderRow(s, sel[s.key] ?? (s.key === 'range' ? 50 : 0))).join('')}</div>` : ''}`;
  $('#ptPick', box).onclick = () => setTool(D.tool === 'point' ? null : 'point');
  $('#ptDel', box).onclick = () => { pts.splice(D.pointSel, 1); D.pointSel = pts.length - 1; D.userEdited = true; renderPointCard(); requestPreview(false); scheduleMeasure(); };
  if ($('#ptList', box)) $('#ptList', box).onclick = (e) => { const i = e.target.closest('button')?.dataset.i; if (i == null) return; D.pointSel = +i; renderPointCard(); };
  bindRows(box.querySelectorAll('#ptSl .sl'), (k, v) => { const q = (P.points || [])[D.pointSel]; if (!q) return; q[k] = v; D.userEdited = true; requestPreview(false); scheduleMeasure(); });
}

async function pointTap(x, y) {
  const p = D.p;
  try {
    const c = await pool.call(p.worker, 'samplePoint', { id: p.id, x, y, params: { ...p.params }, side: previewSide() }, { priority: true });
    if (!D || D.p !== p) return;
    const P = p.params;
    (P.points ||= []).push({ L: c.L, a: c.a, b: c.b, hue: 0, sat: 0, lum: 0, range: 50 });
    D.pointSel = P.points.length - 1;
    setTool(null);
  } catch (e) { toast(e.message, 3000); }
}

async function curveTap(x, y) {
  const p = D.p, key = D.curveChannel, region = D.region;
  try {
    const r = await pool.call(p.worker, 'sampleCurve', { id: p.id, x, y, params: structuredClone(p.params), curveKey: key, region, side: previewSide() }, { priority: true });
    if (!D || D.p !== p) return;
    const points = currentCurvePoints(key).map((q) => [...q]);
    const xi = r.value;
    const close = points.findIndex(([px]) => Math.abs(px - xi) < 8);
    if (close >= 0) points[close][1] = Math.round(curveValueAt(points, points[close][0]));
    else points.push([xi, Math.round(curveValueAt(points, xi))]);
    writeCurvePoints(points); setTool(null); toast('Tone point added. Drag it on the curve to adjust.');
  } catch (e) { toast(e.message, 3000); }
}

// ---------------------------------------------------------------- sync
// Lightroom's Sync: copy this photo's settings to the rest of the shoot. Exposure and white balance stay
// each photo's own by default (light changes between shots); turn them on for a studio with fixed light.
// Heal spots stay off by default (a spot on one frame isn't on the next). Crop is never copied.
const SYNC_OWN = ['exposure', 'temp', 'tint'];
function syncTargets(p) { return S.photos.filter((q) => q !== p && !['loading', 'error', 'solving', 'exporting'].includes(q.status) && q.w); }

function renderSyncCard() {
  if (!D) return;
  const p = D.p, box = $('#syncCard'), n = syncTargets(p).length;
  if (!n) { box.hidden = true; return; }
  box.hidden = false;
  const o = (S.syncOpts ||= { light: false, heals: false });
  box.innerHTML = `<h3>Sync</h3>
    <p class="muted small" style="margin:0 0 6px">Copy this photo's settings to the other ${n} photo${n > 1 ? 's' : ''}. Crop is not copied.</p>
    <label class="chk"><input type="checkbox" id="syLight" ${o.light ? 'checked' : ''}> Exposure and white balance too (only when the light didn't change, like a studio)</label>
    <label class="chk"><input type="checkbox" id="syHeal" ${o.heals ? 'checked' : ''}> Heal spots too</label>
    <div class="row" style="margin-top:8px"><button id="syGo">Sync to ${n} photo${n > 1 ? 's' : ''}</button></div>`;
  $('#syLight', box).onchange = (e) => { o.light = e.target.checked; };
  $('#syHeal', box).onchange = (e) => { o.heals = e.target.checked; };
  $('#syGo', box).onclick = async () => {
    const qs = syncTargets(p);
    $('#syGo', box).disabled = true;
    for (const q of qs) {
      const next = structuredClone(p.params);
      // Automatic skin targets belong to this photo's person IDs.
      if (q.params?.skinMatch) next.skinMatch = structuredClone(q.params.skinMatch);
      else delete next.skinMatch;
      if (!o.light) for (const k of SYNC_OWN) next[k] = q.params ? q.params[k] ?? 0 : 0;
      if (!o.heals) next.heals = q.params && q.params.heals ? q.params.heals : [];
      Object.assign(q, { params: next, solved: structuredClone(next), look: p.look, solvedLook: lookOf(p), finish: p.finish, finishStrength: p.finishStrength, strength: p.strength, split: p.split, status: 'done', synced: true });
    }
    rerenderMatchSoon();
    toast(`Synced to ${qs.length} photo${qs.length > 1 ? 's' : ''}`, 2500);
    // refresh each photo's checks with its new settings
    await Promise.all(qs.map((q) => pool.call(q.worker, 'measureParams', { id: q.id, params: { ...q.params }, auto: null }).then((r) => { q.after = r.after; q.loss = r.loss; }).catch(() => {})));
    rerenderMatchSoon();
    if ($('#syGo')) $('#syGo').disabled = false;
  };
}

async function maskOp(args) {
  const p = D.p;
  const busy = args.op === 'add' || args.op === 'remove' || args.op === 'retry';
  if (busy) toast(args.op === 'add' ? 'Finding what you tapped…' : args.op === 'remove' ? 'Taking it out…' : 'Looking for people and faces again…', 30000);
  try {
    const r = await pool.call(p.worker, 'mask', { id: p.id, ...args }, { priority: true });
    if (busy) $('#toast').hidden = true;
    p.mask = r.mask; p.before = r.before;
    if (args.op === 'retry') { p.faceErr = r.faceErr; noteVision(r, p.file); if (!r.mask.ok) toast("The people finder still won't start. Settings has a check that says why.", 5000); }
    if (!D || D.p !== p) return;
    renderRegionCard();
    if (args.op === 'retry') renderRetouchCard();
    // a new subject changes what the style does, unless the sliders were already hand-tuned
    if (lookOf(p) && !isNoneLook(lookOf(p)) && p.split !== false && !D.userEdited) {
      await solvePhoto(p, { priority: true });
      if (D && D.p === p) { D.userEdited = false; refreshDetail(); }
    } else { requestPreview(false); scheduleMeasure(0); }
  } catch (e) { toast(e.message, 4500); logError('subject mask', e, p.file); }
}

// rebuild the slider and wheel cards for the region being edited
function rebuildControls() {
  const open = [...document.querySelectorAll('#sliders details')].map((d) => d.open);
  $('#sliders').innerHTML = sliderGroups(D.p);
  if (D.region === 'all') [...document.querySelectorAll('#sliders details')].forEach((d, i) => (d.open = open[i] ?? d.open));
  $('#grade').innerHTML = gradeCard(D.p);
  $('#gradeH').textContent = D.region === 'all' ? 'Color grading' : `Color grading · ${D.region === 'subject' ? 'Subject' : 'Background'}`;
  $('#slidersCard').classList.toggle('local', D.region !== 'all');
  renderCurveCard();
  bindSliders();
  bindWheels();
  renderLoss();
}

function drawWheel(el) {
  const z = el.dataset.z, p = D.p, cv = el.querySelector('canvas');
  const css = cv.getBoundingClientRect().width || 110, dpr = Math.min(3, devicePixelRatio || 1);
  if (cv.width !== Math.round(css * dpr)) { cv.width = cv.height = Math.round(css * dpr); }
  const x = cv.getContext('2d'), S = cv.width, c = S / 2, R = S / 2 - 3 * dpr;
  x.clearRect(0, 0, S, S);
  x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = dpr;
  for (const s of [10, 25, 50]) { x.beginPath(); x.arc(c, c, R * satToR(s), 0, 2 * Math.PI); x.stroke(); }
  const pt = (hue, sat) => { const r = R * satToR(sat), t = (hue * Math.PI) / 180; return [c + r * Math.cos(t), c - r * Math.sin(t)]; };
  const V = editVals(), hue = V[`${z}Hue`] || 0, sat = V[`${z}Sat`] || 0;
  const w = D.region === 'all' && p.style && p.style.wheels && p.style.wheels[z];
  if (w && w.move.amount >= 0.5) {
    const [fx, fy] = pt(w.from.hue, w.from.sat);
    const [tx, ty] = pt(w.to.hue, w.to.sat);
    x.strokeStyle = 'rgba(255,255,255,.75)'; x.lineWidth = 1.5 * dpr; x.setLineDash([3 * dpr, 3 * dpr]);
    x.beginPath(); x.moveTo(fx, fy); x.lineTo(tx, ty); x.stroke(); x.setLineDash([]);
    x.fillStyle = 'rgba(255,255,255,.45)'; x.beginPath(); x.arc(fx, fy, 3.5 * dpr, 0, 2 * Math.PI); x.fill();
  }
  const [px, py] = pt(hue, sat);
  const [r, g, b] = hsvToRgb(hue, Math.min(1, 0.25 + sat / 60), 0.95);
  x.fillStyle = sat > 0.05 ? `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})` : '#888';
  x.strokeStyle = '#fff'; x.lineWidth = 2 * dpr;
  x.beginPath(); x.arc(px, py, 7 * dpr, 0, 2 * Math.PI); x.fill(); x.stroke();
  el.querySelector('.wv').textContent = sat > 0.05 ? `${Math.round(hue)}° · ${f1(sat)}` : 'none';
  el.classList.toggle('changed', sat > 0.05);
}

function bindWheels() {
  document.querySelectorAll('#grade .wh').forEach((el) => {
    const z = el.dataset.z, cv = el.querySelector('canvas');
    drawWheel(el);
    let drag = false, lastTap = 0;
    const setFrom = (e) => {
      const r = cv.getBoundingClientRect(), c = r.width / 2, R = r.width / 2 - 3;
      const dx = e.clientX - r.left - c, dy = -(e.clientY - r.top - c);
      const rr = Math.min(1, Math.hypot(dx, dy) / R);
      let h = (Math.atan2(dy, dx) * 180) / Math.PI; if (h < 0) h += 360;
      setVal(`${z}Hue`, Math.round(h));
      setVal(`${z}Sat`, rr < 0.06 ? 0 : Math.round(rToSat(rr) * 10) / 10);
      D.userEdited = true;
      drawWheel(el); requestPreview(false);
    };
    cv.addEventListener('pointerdown', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) { setVal(`${z}Sat`, 0); D.userEdited = true; drawWheel(el); requestPreview(false); scheduleMeasure(); lastTap = 0; return; }
      lastTap = now;
      cv.setPointerCapture(e.pointerId); drag = true; setFrom(e);
    });
    cv.addEventListener('pointermove', (e) => { if (drag) setFrom(e); });
    const end = () => { if (drag) { drag = false; scheduleMeasure(); } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  });
}

// ---------------------------------------------------------------- "what would they do"
const HUE_NAMES = [[12, 'red'], [28, 'red-orange'], [45, 'orange'], [58, 'amber'], [75, 'yellow'], [105, 'yellow-green'], [150, 'green'], [172, 'green-teal'], [195, 'teal'], [215, 'cyan-blue'], [250, 'blue'], [275, 'violet'], [310, 'purple'], [340, 'magenta'], [361, 'red']];
const hueName = (h) => { h = ((h % 360) + 360) % 360; return HUE_NAMES.find(([lim]) => h < lim)[1]; };
const warmth = (h) => (h >= 10 && h < 70 ? 'warmer' : h >= 170 && h < 260 ? 'cooler' : null);

function styleNote(p) {
  const key = finishKeyOf(p);
  const f = FINISH_PROFILES[key];
  if (!f || key === 'off') return '';
  const st = p.style;
  if (!st || p.status === 'solving') return `<p class="muted small" style="margin:8px 0 0">Working out what ${esc(f.name)} would do…</p>`;
  const li = [];
  if (st.blacks > 0) li.push(`Deepen blacks: darkest 1% from L* ${f1(st.start.p1)} to ${f1(st.after.p1)}`);
  else if (st.fade > 0.5) li.push(`Matte blacks: lift the darkest 1% to L* ${f1(st.after.p1)}`);
  if (st.rolloff > 0) li.push(`Roll off highlights: brightest 1% from ${f1(st.start.p99)} to ${f1(st.after.p99)}`);
  if (st.mono) li.push('Black and white photo: tone only, no colour grade');
  else if (st.wheels) {
    for (const [z, label] of WHEELS) {
      const w = st.wheels[z];
      if (!w || w.move.amount < 1) continue;
      const wm = warmth(w.move.hue);
      li.push(`${label}: push toward ${hueName(w.move.hue)}${wm ? ` (${wm})` : ''}, strength ${Math.round(w.move.amount)}`);
    }
    if (Math.abs(st.sat) >= 3) li.push(`${st.sat < 0 ? 'Mute' : 'Boost'} colour ${Math.abs(st.sat)}% (mean chroma ${f1(st.before.chroma)} → ${f1(st.after.chroma)}, theirs ${f1(st.target.chroma)})`);
  }
  if (st.vignette) li.push(`Vignette ${st.vignette}`);
  if (st.grain) li.push(`Grain ${st.grain}`);
  if (!li.length) li.push('Almost nothing: this photo already sits where their work does');
  const basis = st.basis === 'nearest'
    ? `From the ${st.k} of ${st.n} published ${esc(f.name)} photos whose scenes are closest to this one (${esc(f.source)}).`
    : `From all ${st.n} published ${esc(f.name)} photos (${esc(f.source)}).`;
  return `<div class="style"><div class="st-h">What ${esc(f.name)} would do here</div><ul>${li.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p class="muted small">${basis}</p></div>`;
}

const strengthRow = (id, label, v, max) => `<div class="strength"><span class="muted small slbl">${label}</span><input type="range" id="${id}" min="0" max="${max}" step="5" value="${v}"><output id="${id}Out">${v}%</output></div>`;

// The editor's style selection applies to this photo only.
function styleCard(p) {
  const look = lookOf(p), kind = (D && D.styleKind) || look?.kind || 'photographer';
  const pr = presetOf(p), fk = finishKeyOf(p);
  let body;
  if (kind === 'none') {
    body = '<p class="muted small" style="margin:8px 0 0">Use the photo as it was captured. Manual edits remain available below.</p>';
  } else if (kind === 'photographer') {
    body = `<div class="chips-row" id="dPick">${PHOTOGRAPHERS.map((k) => `<button data-l="photographer:${k}" class="${look?.kind === 'photographer' && look.key === k ? 'on' : ''}">${esc(FINISH_PROFILES[k].name)}</button>`).join('')}</div>
      ${look?.kind === 'photographer' ? `<div id="finNote">${styleNote(p)}</div>${strengthRow('fstr', 'Style', p.finishStrength ?? 100, 150)}` : '<p class="muted small" style="margin:8px 0 0">Pick one to restyle this photo.</p>'}`;
  } else {
    body = `<div class="chips-row" id="dPick">${S.presets.map((q) => `<button data-l="preset:${q.id}" class="ref ${look?.kind === 'preset' && look.id === q.id ? 'on' : ''}"><img src="${q.thumb}" alt="">${esc(q.name)}</button>`).join('')}<button data-a="ref">+ Reference</button></div>
      <p class="muted small" style="margin:8px 0 0">Reference matching fits separate light and RGB curves for the subject and background, then matches each person’s skin brightness and color. It adds halation when it detects glow around lights.</p>
      ${pr ? `${strengthRow('str', 'Match', p.strength, 100)}
        <div class="sub">Add a photographer's finish on top</div><div class="fin" id="fin">${finishButtons(p, pr)}</div>
        ${fk !== 'off' ? `<div id="finNote">${styleNote(p)}</div>${strengthRow('fstr', 'Style', p.finishStrength ?? 100, 150)}` : ''}`
    : '<p class="muted small" style="margin:8px 0 0">Pick a reference to copy its look onto this photo.</p>'}`;
  }
  const others = S.photos.length > 1;
  return `<h3>Style</h3><div class="seg wide" id="dSeg"><button data-k="photographer" class="${kind === 'photographer' ? 'on' : ''}">Photographer</button><button data-k="preset" class="${kind === 'preset' ? 'on' : ''}">Reference photo</button><button data-k="none" class="${isNoneLook(look) ? 'on' : ''}">None</button></div>
    ${body}${others && look && !isNoneLook(look) ? '<div class="row" style="margin-top:10px"><button id="lookAll">Use this style on all photos</button></div>' : ''}`;
}

function renderStyleCard() {
  if (!D) return;
  const p = D.p, box = $('#styleCard');
  const pickScrollLeft = $('#dPick', box)?.scrollLeft || 0;
  box.innerHTML = styleCard(p);
  const picks = $('#dPick', box);
  if (picks) picks.scrollLeft = pickScrollLeft;
  const resolve = async () => {
    p.style = null; renderStyleCard();
    await solvePhoto(p, { priority: true });
    if (!D || D.p !== p) return;
    D.userEdited = false;
    refreshDetail();
  };
  $('#dSeg', box).onclick = (e) => {
    const k = e.target.dataset.k; if (!k) return;
    if (k === 'none') { D.styleKind = null; if (!isNoneLook(lookOf(p))) setPhotoNone(p); else renderStyleCard(); return; }
    D.styleKind = k; renderStyleCard();
  };
  if (picks) picks.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'ref') return $('#pickRef').click();
    const [kind, id] = b.dataset.l.split(':');
    const l = kind === 'photographer' ? { kind, key: id } : { kind, id };
    if (sameLook(l, lookOf(p))) return;
    p.look = l; p.finish = undefined;
    if (kind === 'preset') p.strength = presetById(id)?.strength ?? 100;
    resolve();
  };
  if ($('#fin', box)) $('#fin', box).onclick = (e) => { const k = e.target.closest('button')?.dataset.f; if (!k) return; p.finish = k; resolve(); };
  for (const [id, key] of [['str', 'strength'], ['fstr', 'finishStrength']]) {
    const r = $(`#${id}`, box);
    if (!r) continue;
    r.oninput = () => ($(`#${id}Out`, box).textContent = `${r.value}%`);
    r.onchange = () => { p[key] = +r.value; resolve(); };
  }
  if ($('#lookAll', box)) $('#lookAll', box).onclick = () => {
    const l = lookOf(p);
    if (isNoneLook(l)) { setLook(NONE_LOOK); toast(`Plain photo on all ${S.photos.length} photos`); return; }
    S.look = l;
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(l)); } catch (e) { /* private mode */ }
    for (const ph of S.photos) {
      if (ph === p) { ph.look = null; continue; }
      Object.assign(ph, { look: null, finish: p.finish, finishStrength: p.finishStrength, strength: p.strength, split: p.split });
      if (['done', 'exported', 'ready'].includes(ph.status)) ph.status = 'ready';
    }
    runQueue();
    toast(`${lookName(l)} on all ${S.photos.length} photos`);
  };
  // reference thumbnail on the photo follows the look
  const pr = presetOf(p), rt = $('#refthumb'), rl = $('#reflbl');
  if (rt) { rt.hidden = !pr; rl.hidden = !pr; if (pr) rt.src = pr.thumb; }
}

// ---------------------------------------------------------------- detail view
const PAGES = [['look', 'Look'], ['subject', 'Subject'], ['light', 'Light'], ['color', 'Color'], ['retouch', 'Retouch'], ['more', 'More']];
function openDetail(p) {
  p.params ||= defaultParams();
  const el = $('#detail');
  el.hidden = false;
  el.classList.remove('cropping');
  document.body.style.overflow = 'hidden';
  const compactPortrait = matchMedia('(max-width: 700px) and (orientation: portrait)').matches;
  el.classList.toggle('panel-collapsed', compactPortrait);
  el.innerHTML = `<div class="editor-layout" id="editorLayout"><main class="editor-main" id="editorMain"><div class="dtop">
      <div class="dhead"><button class="ghost" id="dBack">‹ Back</button><div class="nm">${esc(p.name)}${p.cull ? ` <span class="muted small">${p.cull.eyes ? `eyes ${p.cull.eyes}` : ''}${p.cull.eyes && p.cull.focus != null ? ' · ' : ''}${p.cull.focus != null ? `focus ${p.cull.focus.toFixed(1)}` : ''}</span>` : ''}</div><button id="dKeep" class="${p.picked ? 'on' : ''}" aria-pressed="${!!p.picked}" aria-label="Pick">★</button><button class="primary" id="dExport">Export</button></div>
      <div class="stage" id="stage"><canvas id="cv"></canvas><span class="lbl l" id="lblL">Before</span><span class="lbl r" id="lblR">After</span>
        <img class="refthumb" id="refthumb" alt="reference" hidden><span class="reflbl" id="reflbl" hidden>ref</span></div>
      <div class="dctl" id="dctl"><div class="seg" id="mode"><button data-m="before">Before</button><button data-m="split" class="on">Split</button><button data-m="after">After</button></div></div>
      <div class="cropbar" id="cropbar" hidden>
        <div class="aspects" id="aspects"><button data-a="free">Free</button><button data-a="orig">Original</button><button data-a="1">1:1</button><button data-a="0.8">4:5</button><button data-a="1.5">3:2</button><button data-a="1.7778">16:9</button><button data-a="flip" aria-label="Swap width and height">⇄</button></div>
        <div class="level"><label for="lvl">Level</label><input type="range" id="lvl" min="-45" max="45" step="0.1" value="0"><output id="lvlOut">0.0°</output><button id="lvlAuto">Auto</button></div>
        <div class="row"><button class="ghost" id="cropReset">Reset</button><div class="grow"></div><button id="cropCancel">Cancel</button><button class="primary" id="cropDone">Done</button></div>
      </div>
      <div class="lossbar" id="loss"></div>
    </div></main>
    <aside class="dpanel" id="dbody">
      <div class="panel-head"><div class="panel-topline"><strong class="panel-title">Controls</strong><button class="panel-toggle" id="panelToggle" type="button" aria-label="Collapse controls" aria-expanded="true">‹</button></div>
        <div class="edit-actions"><button id="cropBtn" class="${p.geom ? 'on' : ''}">Crop</button><button id="autoAdjust" class="primary" title="Correct exposure, set fade, fit the curves, then pick and adjust colors toward the chosen look (or a clean portrait look)">Auto Adjust</button><button id="undo" disabled title="Undo the last edit (Ctrl+Z)">Undo</button><button id="reMatch" title="Match this photo to its reference again">Re-match</button></div>
        <nav class="ptabs" id="ptabs" aria-label="Editing sections">${PAGES.map(([k, l]) => `<button data-p="${k}" title="${l}" aria-label="${l}"><span class="tab-icon" aria-hidden="true">${({ look: '◉', subject: '◌', light: '☼', color: '◐', retouch: '✦', more: '⋯' })[k]}</span><span class="tab-label">${l}</span></button>`).join('')}</nav>
      </div>
      <div class="pager" id="pager">
        <div class="page" data-p="look"><div class="card" id="styleCard"></div></div>
        <div class="page" data-p="subject"><div class="card" id="regionCard"></div></div>
        <div class="page" data-p="light"><div class="card" id="slidersCard"><div id="sliders"></div></div><div class="card" id="curveCard"></div></div>
        <div class="page" data-p="color"><div class="card"><h3 id="gradeH">Color grading</h3><div id="grade"></div></div><div class="card" id="pointCard"></div></div>
        <div class="page" data-p="retouch"><div class="card" id="retouchCard"></div></div>
        <div class="page" data-p="more"><div class="card" id="syncCard"></div><div class="card"><h3>Measurements</h3><div id="nums">${numbersTable(p)}</div></div></div>
      </div>
    </aside></div>`;
  D = { p, mode: 'split', split: 0.5, orig: null, edit: null, busy: false, again: false, overlay: false, holding: false, crop: null, styleKind: null, region: 'all', pick: null, showMask: false, flash: false, panelOpen: !compactPortrait, compactPortrait,
    tool: null, healSel: -1, healSize: 0.015, healOp: 0.6, pointSel: -1, curveChannel: 'curve', curveDrag: null, curveSnap: false, view: { s: 1, x: 0, y: 0 }, hi: false, page: 'look',
    hist: { stack: [], cur: editSnap(p) } };
  $('#sliders').innerHTML = sliderGroups(p);
  $('#grade').innerHTML = gradeCard(p);
  bindPager();
  $('#dBack').onclick = closeDetail;
  $('#dExport').onclick = () => exportPhotos([p]);
  $('#dKeep').onclick = () => { p.picked = !p.picked; $('#dKeep').classList.toggle('on', p.picked); $('#dKeep').setAttribute('aria-pressed', String(p.picked)); };
  $('#mode').onclick = (e) => { const m = e.target.dataset.m; if (!m) return; D.mode = m; [...$('#mode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === m)); draw(); };
  $('#cropBtn').onclick = () => enterCrop();
  $('#reMatch').onclick = async () => {
    $('#reMatch').disabled = true; $('#reMatch').textContent = 'Working…';
    await solvePhoto(p, { priority: true });
    D && (D.userEdited = false);
    refreshDetail(); $('#reMatch').disabled = false; $('#reMatch').textContent = 'Re-match';
  };
  $('#undo').onclick = undo;
  $('#autoAdjust').onclick = async () => {
    const btn = $('#autoAdjust'); btn.disabled = true; btn.textContent = 'Adjusting…';
    try {
      const sa = solveArgs(p), rs = sa?.refStats;
      // the look Auto Adjust chases: the reference's measured tone, skin and colour bands, or the photographer's finish
      const look = !sa ? null : rs ? { kind: 'reference', refStats: { tone: { pct: rs.tone?.pct }, bands: rs.bands, bandsBg: rs.bandsBg, zones: rs.zones, skin: rs.skin, color: { meanChroma: rs.color?.meanChroma } } } : { kind: 'photographer', finish: sa.finish };
      const r = await pool.call(p.worker, 'autoAdjust', { id: p.id, params: structuredClone(p.params || defaultParams()), look }, { priority: true });
      if (!D || D.p !== p) return;
      const preservedReference = r.preservedReference === true;
      delete r.preservedReference;
      if (preservedReference) {
        toast('Reference match preserved. Use Re-match to recalculate it.');
        return;
      }
      delete (p.params ||= defaultParams()).curveAuto;
      Object.assign(p.params ||= defaultParams(), r);
      p.solved = structuredClone(p.params); p.status = 'done'; D.userEdited = true;
      refreshDetail(); D.goPage('light');
      const visible = new Set(['Tone', 'Tone curve', 'Presence', 'HSL hue', 'HSL saturation', 'HSL luminance']);
      $('#sliders').querySelectorAll('details.group').forEach((group) => {
        if (visible.has($('summary', group)?.textContent.trim())) group.open = true;
      });
      toast('Auto Adjust applied: fade, curves, point colors and HSL are set toward the look. Undo puts it back.');
    } catch (e) { toast(e.message, 4500); logError('auto adjust', e, p.file); }
    finally { if ($('#autoAdjust')) { $('#autoAdjust').disabled = false; $('#autoAdjust').textContent = 'Auto Adjust'; } }
  };
  renderStyleCard();
  renderRegionCard();
  renderRetouchCard();
  renderPointCard();
  renderCurveCard();
  renderSyncCard();
  bindCropBar();
  bindSliders();
  bindWheels();
  bindStage();
  syncEditorLayout();
  renderLoss();
  requestPreview(true);
  scheduleMeasure(0);
}

// Controls scroll vertically in the left pane; section tabs jump within that pane.
function bindPager() {
  const pager = $('#pager'), tabs = $('#ptabs');
  const mark = (k) => {
    D.page = k;
    tabs.querySelectorAll('button[data-p]').forEach((b) => {
      const selected = b.dataset.p === k;
      b.classList.toggle('on', selected);
      b.setAttribute('aria-current', selected ? 'page' : 'false');
    });
  };
  const pageEl = (k) => pager.querySelector(`.page[data-p="${k}"]`);
  D.setPanelOpen = (open) => {
    D.panelOpen = !!open;
    $('#detail').classList.toggle('panel-collapsed', !D.panelOpen);
    const toggle = $('#panelToggle');
    toggle.textContent = D.panelOpen ? '‹' : '›';
    toggle.setAttribute('aria-expanded', String(D.panelOpen));
    toggle.setAttribute('aria-label', D.panelOpen ? 'Collapse controls' : 'Expand controls');
  };
  $('#panelToggle').onclick = () => D.setPanelOpen(!D.panelOpen);
  D.setPanelOpen(D.panelOpen);
  D.goPage = (k, smooth = true) => {
    const el = pageEl(k);
    if (!el) return;
    if (!D.panelOpen) D.setPanelOpen(true);
    mark(k);
    pager.scrollTo({ top: pager.scrollTop + el.getBoundingClientRect().top - pager.getBoundingClientRect().top, behavior: smooth ? 'smooth' : 'auto' });
  };
  tabs.onclick = (e) => {
    const k = e.target.closest('button')?.dataset.p;
    if (k) D.goPage(k);
  };
  let t;
  pager.onscroll = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const top = pager.getBoundingClientRect().top + 8;
      let active = pager.children[0];
      for (const page of pager.children) {
        if (page.getBoundingClientRect().top <= top) active = page;
        else break;
      }
      const k = active?.dataset.p;
      if (k && k !== D?.page) mark(k);
    }, 60);
  };
  mark('look');
}

// ---------------------------------------------------------------- editor pane sizing
function syncEditorLayout() {
  if (!D) return;
  const st = $('#stage');
  if (st) st.style.height = '';
  $('#refthumb')?.classList.remove('mini');
}
window.addEventListener('resize', () => {
  if (!D) return;
  const compactPortrait = matchMedia('(max-width: 700px) and (orientation: portrait)').matches;
  if (compactPortrait !== D.compactPortrait) {
    D.compactPortrait = compactPortrait;
    D.setPanelOpen(!compactPortrait);
  }
  syncEditorLayout();
  if (D.crop) drawCrop();
});

function finishButtons(p, pr) {
  const cur = p.finish || pr?.finish || 'off';
  return Object.entries(FINISH_PROFILES).map(([k, f]) => `<button data-f="${k}" class="${k === cur ? 'on' : ''}">${esc(f.name)}</button>`).join('');
}

const SL_LABEL = Object.fromEntries(SLIDERS.map((s) => [s.key, s.label]));
for (const r of REGIONS) for (const s of LOCAL_SLIDERS) SL_LABEL[`${r}:${s.key}`] = `${r === 'subject' ? 'Subject' : 'Background'} ${s.label.toLowerCase()}`;
function fmtVal(k, v) { k = k.split(':').pop(); return k === 'exposure' ? `${v > 0 ? '+' : ''}${(+v).toFixed(2)}` : `${v > 0 ? '+' : ''}${Math.round(v)}`; }
// region keys ('subject:exposure') live on that region's tab
const controlFor = (k) => {
  const j = k.indexOf(':');
  if (j >= 0) return D && D.region === k.slice(0, j) ? document.querySelector(`#sliders .sl[data-k="${k.slice(j + 1)}"]`) : null;
  if (D && D.region !== 'all') return null;
  return document.querySelector(`#sliders .sl[data-k="${k}"], #grade .sl[data-k="${k}"], #grade .wh[data-keys~="${k}"]`);
};

function renderLoss() {
  if (!D) return;
  const box = $('#loss');
  const L = D.p.loss;
  document.querySelectorAll('#sliders .culprit, #grade .culprit').forEach((r) => r.classList.remove('culprit'));
  if (!L) { box.innerHTML = ''; return; }
  if (!L.issues.length) {
    box.className = 'lossbar ok';
    box.innerHTML = `<div class="lrow"><span>Nothing blown, crushed or flattened by this edit.</span></div>`;
    return;
  }
  box.className = `lossbar ${L.worst}`;
  const chips = L.issues.map((i) => `<span class="lchip ${i.level}">${esc(i.text)}</span>`).join('');
  const cul = (L.culprits || []).map((c) => `<button class="lnk" data-k="${c.key}">${esc(SL_LABEL[c.key] || c.key)} ${fmtVal(c.key, c.value)}</button>`).join(', ');
  box.innerHTML = `<div class="lrow">${chips}</div>${cul ? `<div class="lrow small">Mostly from ${cul}</div>` : ''}`;
  for (const c of L.culprits || []) controlFor(c.key)?.classList.add('culprit');
  box.querySelectorAll('button.lnk[data-k]').forEach((b) => (b.onclick = () => jumpToSlider(b.dataset.k)));
}

function jumpToSlider(k) {
  const want = k.includes(':') ? k.split(':')[0] : 'all';
  if (D.region !== want) { D.region = want; renderRegionCard(); rebuildControls(); requestPreview(false); }
  const row = controlFor(k);
  if (!row) return;
  const dt = row.closest('details'); if (dt) dt.open = true;
  const page = row.closest('.page'), pager = $('#pager');
  if (page) D.goPage(page.dataset.p, false);
  requestAnimationFrame(() => pager.scrollTo({ top: pager.scrollTop + row.getBoundingClientRect().top - pager.getBoundingClientRect().top - 12, behavior: 'smooth' }));
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}

// Undo: every edit ends in scheduleMeasure, so its debounce is where an edit counts as finished
// (a whole slider drag is one step). Snapshots are the photo's params, as JSON, per open photo.
const UNDO_MAX = 50;
const editSnap = (p) => JSON.stringify({ params: p.params || null, solved: p.solved || null, look: p.look ?? null, finish: p.finish ?? null, finishStrength: p.finishStrength ?? null, strength: p.strength ?? null, split: p.split ?? null });
function commitEdit() {
  if (!D || !D.hist) return;
  const s = editSnap(D.p);
  if (s === D.hist.cur) return;
  D.hist.stack.push(D.hist.cur);
  if (D.hist.stack.length > UNDO_MAX) D.hist.stack.shift();
  D.hist.cur = s;
  syncUndo();
}
function recordLookResetUndo(before) {
  if (!D?.hist || before == null) return;
  const after = editSnap(D.p);
  if (before !== after) {
    D.hist.stack.push(before);
    if (D.hist.stack.length > UNDO_MAX) D.hist.stack.shift();
  }
  D.hist.cur = after;
  syncUndo();
}
function syncUndo() { if (D && $('#undo')) $('#undo').disabled = !D.hist.stack.length; }
function undo() {
  if (!D || D.crop) return;
  commitEdit();
  const prev = D.hist.stack.pop();
  if (!prev) return;
  D.hist.cur = prev;
  const o = JSON.parse(prev);
  D.p.params = o.params || defaultParams(); D.p.solved = o.solved || null;
  if (Object.hasOwn(o, 'look')) D.p.look = o.look;
  if (Object.hasOwn(o, 'finish')) D.p.finish = o.finish;
  if (Object.hasOwn(o, 'finishStrength')) D.p.finishStrength = o.finishStrength;
  if (Object.hasOwn(o, 'strength')) D.p.strength = o.strength;
  if (Object.hasOwn(o, 'split')) D.p.split = o.split;
  D.p.solvedLook = lookOf(D.p);
  D.userEdited = true;
  syncUndo();
  refreshDetail();
}
document.addEventListener('keydown', (e) => {
  if (!D || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  e.preventDefault(); undo();
});

let measureT;
function scheduleMeasure(delay = 350) {
  clearTimeout(measureT);
  measureT = setTimeout(async () => {
    if (!D) return;
    commitEdit();
    const p = D.p;
    const r = await pool.call(p.worker, 'measureParams', { id: p.id, params: { ...p.params }, auto: p.solved || null }, { priority: true });
    if (!D || D.p !== p) return;
    p.after = r.after; p.loss = r.loss;
    $('#nums').innerHTML = numbersTable(p);
    const wasBad = D.lastWorst === 'bad';
    D.lastWorst = r.loss.worst;
    renderLoss();
    // first time an edit goes badly wrong, show where on the photo
  }, delay);
}

function refreshDetail() {
  if (!D) return;
  $('#nums').innerHTML = numbersTable(D.p);
  renderStyleCard();
  renderRegionCard();
  renderRetouchCard();
  renderPointCard();
  rebuildControls();
  requestPreview(false);
  scheduleMeasure(0);
}

function bindSliders() {
  document.querySelectorAll('#sliders .sl, #grade .sl').forEach((row) => {
    const k = row.dataset.k;
    const [range, num] = row.querySelectorAll('input');
    const local = D.region !== 'all' && !!row.closest('#sliders');
    const set = (v, from) => {
      const s = (local ? LOCAL_SLIDERS : SLIDERS).find((x) => x.key === k);
      v = Math.max(s.ui[0], Math.min(s.ui[1], +v || 0));
      if (local) setVal(k, v); else D.p.params[k] = v;
      D.userEdited = true;
      if (from !== range) range.value = v;
      if (from !== num) num.value = s.step ? v.toFixed(2) : Math.round(v);
      row.classList.toggle('changed', Math.abs(v) > 1e-9);
      requestPreview(false);
      scheduleMeasure();
    };
    range.oninput = () => set(range.value, range);
    num.onchange = () => set(num.value, num);
    row.querySelector('label').ondblclick = () => set(0);
  });
}

const previewSide = () => Math.min(1600, Math.round(Math.max(window.innerWidth, 400) * Math.min(2, devicePixelRatio || 1)));

async function requestPreview(withOriginal) {
  if (!D) return;
  if (D.crop) return; // the crop tool draws its own frame
  if (D.busy) { D.again = true; return; }
  D.busy = true;
  const p = D.p;
  try {
    const showMask = D.pick ? 'subject' : D.region !== 'all' && (D.showMask || D.flash) ? D.region : D.showMask ? 'subject' : null;
    const r = await pool.call(p.worker, 'preview', { id: p.id, params: { ...p.params }, side: previewSide(), overlay: D.overlay, withOriginal: withOriginal || !D.orig, showMask }, { priority: true });
    if (!D || D.p !== p) return;
    if (r.original) D.orig = r.original;
    D.edit = r.edited;
    draw();
  } catch (e) { toast(e.message); logError('preview', e, p.file); }
  if (!D) return;
  D.busy = false;
  if (D.again) { D.again = false; requestPreview(false); }
}

function draw() {
  if (!D) return;
  if (D.crop) return drawCrop();
  if (!D.edit) return;
  const cv = $('#cv');
  const { width: w, height: hgt } = D.edit;
  if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
  const x = cv.getContext('2d');
  const m = D.holding ? 'before' : D.mode;
  const orig = D.orig && D.orig.width === w && D.orig.height === hgt ? D.orig : null;
  if (m === 'after' || !orig) x.drawImage(D.edit, 0, 0);
  else if (m === 'before') x.drawImage(orig, 0, 0);
  else {
    const sx = Math.round(w * D.split);
    x.drawImage(orig, 0, 0, sx, hgt, 0, 0, sx, hgt);
    x.drawImage(D.edit, sx, 0, w - sx, hgt, sx, 0, w - sx, hgt);
    x.fillStyle = 'rgba(255,255,255,.9)'; x.fillRect(sx - 1, 0, 2, hgt);
  }
  drawHeals(x, cv);
  $('#lblL').hidden = m === 'after'; $('#lblR').hidden = m === 'before';
  $('#lblR').textContent = D.mode === 'after' && !D.holding ? 'After · hold for before' : 'After';
}

function bindStage() {
  const cv = $('#cv');
  let dragging = false;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    if (D.crop) return cropDown(e);
    if (D.tool) {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      if (x >= 0 && y >= 0 && x <= 1 && y <= 1) toolTap(x, y);
      return;
    }
    if (D.pick) {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      if (x >= 0 && y >= 0 && x <= 1 && y <= 1) maskOp({ op: D.pick, x, y });
      return;
    }
    if (D.mode === 'split') { dragging = true; D.split = pos(e); }
    else if (D.mode === 'after') D.holding = true;
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (D.crop) return cropMove(e);
    if (dragging) { D.split = pos(e); draw(); }
  });
  const up = (e) => {
    if (D && D.crop) return cropUp(e);
    dragging = false; if (D && D.holding) { D.holding = false; draw(); }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}

function closeDetail() {
  clearTimeout(measureT);
  const el = $('#detail');
  el.onscroll = null; el.classList.remove('cropping');
  el.hidden = true; el.innerHTML = '';
  document.body.style.overflow = '';
  D = null;
  renderMatch();
}

// ---------------------------------------------------------------- crop + level
// The photo turns under a fixed frame (like Lightroom): the frame is drawn over the whole turned
// photo and can't leave it. Done hands the geometry to the worker, which crops before measuring,
// so the match and the loss checks see only what's kept.
function cropDims() { return [D.p.w || D.crop.img.width, D.p.h || D.crop.img.height]; }
const rectAspect = (r) => { const [W, H] = cropDims(); return (r.w * W) / (r.h * H); };

async function enterCrop() {
  const p = D.p;
  const [W, H] = [p.w, p.h];
  const g = p.geom;
  D.crop = {
    angle: g ? g.angle : 0, r: g ? { x: g.x, y: g.y, w: g.w, h: g.h } : { x: 0, y: 0, w: 1, h: 1 },
    aspect: g ? null : W / H, auto: !g, prev: g ? { ...g } : null, img: null, drag: null,
  };
  const det = $('#detail');
  det.classList.add('cropping');
  $('#dctl').hidden = true; $('#cropbar').hidden = false; $('#loss').hidden = true; $('#dbody').hidden = true;
  $('#lblL').hidden = true; $('#lblR').hidden = true;
  syncEditorLayout();
  syncCropBar();
  try {
    const r = await pool.call(p.worker, 'preview', { id: p.id, params: { ...p.params }, side: previewSide(), plain: true }, { priority: true });
    if (!D || !D.crop) return;
    D.crop.img = r.edited;
    drawCrop();
  } catch (e) { toast(e.message); exitCrop(); }
}

function exitCrop() {
  if (!D) return;
  D.crop = null;
  const det = $('#detail');
  det.classList.remove('cropping');
  $('#dctl').hidden = false; $('#cropbar').hidden = true; $('#loss').hidden = false; $('#dbody').hidden = false;
  syncEditorLayout();
  $('#cropBtn').classList.toggle('on', !!D.p.geom);
}

function syncCropBar() {
  const c = D.crop;
  $('#lvl').value = c.angle; $('#lvlOut').textContent = `${c.angle > 0 ? '+' : ''}${(+c.angle).toFixed(1)}°`;
  const [W, H] = [D.p.w, D.p.h];
  const cur = c.aspect;
  document.querySelectorAll('#aspects button').forEach((b) => {
    const a = b.dataset.a;
    let on = false;
    if (a === 'free') on = cur == null;
    else if (a === 'orig') on = cur != null && Math.abs(cur - W / H) < 1e-3;
    else if (a !== 'flip') on = cur != null && !(Math.abs(cur - W / H) < 1e-3) && (Math.abs(cur - +a) < 1e-3 || Math.abs(cur - 1 / +a) < 1e-3);
    b.classList.toggle('on', on);
  });
}

function bindCropBar() {
  $('#aspects').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a || !D.crop?.img) return;
    const c = D.crop, [W, H] = cropDims();
    const r = c.r, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (a === 'free') { c.aspect = null; syncCropBar(); return; }
    let asp;
    if (a === 'orig') asp = W / H;
    else if (a === 'flip') asp = 1 / rectAspect(r);
    else asp = +a; // as labelled (width:height); ⇄ turns it the other way
    c.aspect = asp; c.auto = true;
    c.r = maxRect(W, H, c.angle, asp, cx, cy);
    syncCropBar(); drawCrop();
  };
  const lvl = $('#lvl');
  lvl.oninput = () => { if (D.crop) D.crop.drag = 'level'; setAngle(+lvl.value); };
  lvl.onchange = () => { if (D.crop) { D.crop.drag = null; drawCrop(); } };
  $('#lvlAuto').onclick = async () => {
    const b = $('#lvlAuto'); b.disabled = true; b.textContent = '…';
    try {
      const r = await pool.call(D.p.worker, 'autoLevel', { id: D.p.id }, { priority: true });
      if (!D || !D.crop) return;
      if (r.confidence < 0.15) toast('No clear horizon or straight lines to level from');
      else { setAngle(r.angle); toast(`Levelled ${r.angle > 0 ? '+' : ''}${r.angle.toFixed(1)}°`); }
    } catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = 'Auto';
  };
  $('#cropReset').onclick = () => {
    const c = D.crop, [W, H] = cropDims();
    c.angle = 0; c.aspect = W / H; c.auto = true; c.r = { x: 0, y: 0, w: 1, h: 1 };
    syncCropBar(); drawCrop();
  };
  $('#cropCancel').onclick = () => exitCrop() || requestPreview(false);
  $('#cropDone').onclick = async () => {
    const p = D.p, c = D.crop;
    const g = { angle: Math.round(c.angle * 10) / 10, x: c.r.x, y: c.r.y, w: c.r.w, h: c.r.h };
    const geom = isIdentityGeom(g) ? null : g;
    const changed = JSON.stringify(geom) !== JSON.stringify(p.geom || null);
    exitCrop();
    if (!changed) return requestPreview(false);
    p.geom = geom;
    $('#cropBtn').classList.toggle('on', !!geom);
    try {
      const r = await pool.call(p.worker, 'setGeom', { id: p.id, geom }, { priority: true });
      p.before = r.before;
    } catch (e) { toast(e.message); logError('crop', e, p.file); return; }
    if (!D || D.p !== p) return;
    D.orig = null;
    requestPreview(true);
    if (!D.userEdited) {
      $('#reMatch').disabled = true; $('#reMatch').textContent = 'Working…';
      await solvePhoto(p, { priority: true });
      if (!D || D.p !== p) return;
      refreshDetail(); $('#reMatch').disabled = false; $('#reMatch').textContent = 'Re-match';
    } else {
      $('#nums').innerHTML = numbersTable(p);
      scheduleMeasure(0);
      toast('Cropped. Your slider changes are kept; tap Redo to fit the style to the crop.', 4500);
    }
  };
}

function setAngle(a) {
  const c = D.crop;
  if (!c) return;
  const [W, H] = cropDims();
  c.angle = Math.max(-45, Math.min(45, a));
  if (c.auto) { const asp = c.aspect || rectAspect(c.r); c.r = maxRect(W, H, c.angle, asp); }
  else c.r = fitAfterTurn(c.r, W, H, c.angle);
  syncCropBar(); drawCrop();
}

function drawCrop() {
  const c = D && D.crop;
  if (!c || !c.img) return;
  const cv = $('#cv'), img = c.img, w = img.width, h = img.height;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const x = cv.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.save(); x.translate(w / 2, h / 2); x.rotate((c.angle * Math.PI) / 180); x.drawImage(img, -w / 2, -h / 2); x.restore();
  const rx = c.r.x * w, ry = c.r.y * h, rw = c.r.w * w, rh = c.r.h * h;
  x.fillStyle = 'rgba(0,0,0,.58)';
  x.beginPath(); x.rect(0, 0, w, h); x.rect(rx, ry, rw, rh); x.fill('evenodd');
  const k = w / (cv.getBoundingClientRect().width || w); // canvas px per CSS px
  x.strokeStyle = 'rgba(255,255,255,.95)'; x.lineWidth = 1.5 * k; x.strokeRect(rx, ry, rw, rh);
  // thirds while dragging, a finer grid while levelling helps line up the horizon
  x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1 * k;
  const n = c.drag === 'level' ? 6 : 3;
  x.beginPath();
  for (let i = 1; i < n; i++) { x.moveTo(rx + (rw * i) / n, ry); x.lineTo(rx + (rw * i) / n, ry + rh); x.moveTo(rx, ry + (rh * i) / n); x.lineTo(rx + rw, ry + (rh * i) / n); }
  x.stroke();
  // corner handles
  x.strokeStyle = '#fff'; x.lineWidth = 3.5 * k; const L = 18 * k;
  for (const [cx, cy, sx, sy] of [[rx, ry, 1, 1], [rx + rw, ry, -1, 1], [rx + rw, ry + rh, -1, -1], [rx, ry + rh, 1, -1]]) {
    x.beginPath(); x.moveTo(cx + sx * L, cy); x.lineTo(cx, cy); x.lineTo(cx, cy + sy * L); x.stroke();
  }
}

function cropHit(e) {
  const cv = $('#cv'), b = cv.getBoundingClientRect();
  const u = (e.clientX - b.left) / b.width, v = (e.clientY - b.top) / b.height;
  const r = D.crop.r;
  const px = [r.x * b.width, r.y * b.height, (r.x + r.w) * b.width, (r.y + r.h) * b.height];
  const ex = e.clientX - b.left, ey = e.clientY - b.top;
  const corners = [[px[0], px[1]], [px[2], px[1]], [px[2], px[3]], [px[0], px[3]]];
  let best = -1, bd = 30;
  corners.forEach(([cx, cy], i) => { const d = Math.hypot(ex - cx, ey - cy); if (d < bd) { bd = d; best = i; } });
  if (best >= 0) return { kind: 'corner', i: best, u, v };
  if (D.crop.aspect == null) {
    const inY = ey > px[1] && ey < px[3], inX = ex > px[0] && ex < px[2];
    if (inY && Math.abs(ex - px[0]) < 20) return { kind: 'edge', side: 'l', u, v };
    if (inY && Math.abs(ex - px[2]) < 20) return { kind: 'edge', side: 'r', u, v };
    if (inX && Math.abs(ey - px[1]) < 20) return { kind: 'edge', side: 't', u, v };
    if (inX && Math.abs(ey - px[3]) < 20) return { kind: 'edge', side: 'b', u, v };
  }
  if (ex > px[0] && ex < px[2] && ey > px[1] && ey < px[3]) return { kind: 'move', u, v };
  return null;
}

function cropDown(e) {
  const c = D.crop;
  if (!c || !c.img) return;
  const hit = cropHit(e);
  if (!hit) return;
  c.drag = hit.kind; c.hit = hit; c.start = { ...c.r };
  drawCrop();
}

function cropMove(e) {
  const c = D.crop;
  if (!c || !c.drag || c.drag === 'level') return;
  const cv = $('#cv'), b = cv.getBoundingClientRect();
  const u = (e.clientX - b.left) / b.width, v = (e.clientY - b.top) / b.height;
  const [W, H] = cropDims(), s = c.start, MIN = 0.06;
  const valid = (a, t) => towardValid(a, t, W, H, c.angle);
  let t;
  if (c.drag === 'move') {
    const du = u - c.hit.u, dv = v - c.hit.v;
    const shift = (r, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy });
    t = shift(s, du, dv);
    if (!validRect(t, W, H, c.angle)) { const a = valid(s, shift(s, du, 0)); t = valid(a, shift(a, 0, dv)); }
  } else if (c.drag === 'corner') {
    const i = c.hit.i;
    const ax = i === 0 || i === 3 ? s.x + s.w : s.x, ay = i === 0 || i === 1 ? s.y + s.h : s.y;
    const sx = i === 0 || i === 3 ? -1 : 1, sy = i === 0 || i === 1 ? -1 : 1;
    let nw = Math.max(MIN, (u - ax) * sx), nh = Math.max(MIN, (v - ay) * sy);
    if (c.aspect) {
      const hp = ((nw * W) / c.aspect + nh * H) / 2; // meet the finger half-way between width and height
      nw = (hp * c.aspect) / W; nh = hp / H;
    }
    t = valid(s, { x: sx < 0 ? ax - nw : ax, y: sy < 0 ? ay - nh : ay, w: nw, h: nh });
  } else if (c.drag === 'edge') {
    const sd = c.hit.side;
    if (sd === 'l') { const x = Math.min(u, s.x + s.w - MIN); t = { ...s, x, w: s.x + s.w - x }; }
    if (sd === 'r') t = { ...s, w: Math.max(MIN, u - s.x) };
    if (sd === 't') { const y = Math.min(v, s.y + s.h - MIN); t = { ...s, y, h: s.y + s.h - y }; }
    if (sd === 'b') t = { ...s, h: Math.max(MIN, v - s.y) };
    t = valid(s, t);
  }
  if (t) { c.r = t; c.auto = false; drawCrop(); }
}

function cropUp() {
  const c = D.crop;
  if (!c) return;
  c.drag = null; drawCrop();
}

// ---------------------------------------------------------------- export
progressListeners.add((pr) => {
  if (pr.phase === 'heif') { const p = S.photos.find((q) => q.id === pr.id); if (p) { p.phase = 'heif'; rerenderMatchSoon(); } }
});
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
  const pr = { name: lookName(list.length === 1 ? lookOf(list[0]) : S.look) || 'look' };
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
  return { id: p.id, params: p.params, geom: p.geom || null, quality: S.settings.quality, lightroom: S.settings.lightroom, lrMode: S.settings.lrMode, name: baseName(p.name) };
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
  const errs = readErrors();
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
    <div class="card"><h3>Model assist</h3>
      <p class="muted small">Optional. Paste the URL of your Deep Preset Space (see <code>server/README.md</code>). Each photo matched to a saved reference is sent there at 512 px, and the solver chases the result. Leave empty to keep everything on this phone. If the server fails, the plain match runs instead.</p>
      <div class="field"><label class="t">Space URL</label><input type="url" id="sModel" placeholder="https://name-space.hf.space" value="${esc(s.modelUrl || '')}"></div>
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
    <div class="card"><h3>Recent problems</h3>${errs.length ? `<p class="small">${errs.length} logged on this device. Latest: ${esc(errs[0].step)}, ${esc(errs[0].message)}</p><div class="bar"><button id="sErrCopy">Copy all</button><button class="ghost" id="sErrClear">Clear</button></div>` : '<p class="muted small">None logged.</p>'}</div>
    <div class="card"><h3>Subject and skin detection</h3><p class="muted small">Runs the face and people models on this phone and lists each step. If subject, background or skin detection isn't working, run it and send me the copied result.</p><div class="bar"><button id="sVis">Run check</button></div><div id="sVisOut"></div></div>
    <div class="card"><h3>About</h3><p class="muted small">Everything runs on this phone. Photo presets store measured targets, not slider values. Imported Lightroom presets apply their exact values after each photo's exposure and white balance are normalised. Each photo is measured and solved on its own. Workers: ${pool.workers.length}. Version ${APP_VERSION}.</p></div>
  </div>`;
  $('#sDest').value = s.dest; $('#sLRM').value = s.lrMode;
  $('#sDest').onchange = (e) => { s.dest = e.target.value; saveSettings(); };
  $('#sModel').onchange = (e) => { s.modelUrl = e.target.value.trim().replace(/\/+$/, ''); saveSettings(); };
  $('#sQ').onchange = (e) => { s.quality = Math.max(60, Math.min(100, +e.target.value || 92)); saveSettings(); };
  $('#sLR').onchange = (e) => { s.lightroom = e.target.checked; saveSettings(); };
  $('#sLRM').onchange = (e) => { s.lrMode = e.target.value; saveSettings(); };
  $('#sCID').oninput = (e) => { s.clientId = e.target.value.trim(); saveSettings(); $('#sConn').disabled = !s.clientId; };
  $('#sConn').onclick = async () => {
    if (S.photos.length && !(await confirmSheet('Reload to sign in?', 'Photos you added will need to be added again.', 'Continue'))) return;
    drive.connect(s.clientId);
  };
  $('#sVis').onclick = async () => {
    const b = $('#sVis'), out = $('#sVisOut');
    b.disabled = true;
    out.innerHTML = '<p class="muted small">Checking. This can take a minute the first time.</p>';
    let text;
    try {
      const r = await pool.call(0, 'visionCheck', {}, { priority: true });
      text = [`LookMatch ${APP_VERSION}`, `Browser: ${navigator.userAgent}`, `Home-screen app: ${navigator.standalone === true}`, `Workers: ${pool.workers.length}`, '']
        .concat(r.rows.map((x) => `${x.ok ? 'OK  ' : 'FAIL'} ${x.step} (${x.ms} ms)${x.detail ? `: ${x.detail}` : ''}`)).join('\n');
    } catch (e) { text = `The check itself failed: ${e.message}`; }
    out.innerHTML = `<pre class="small" style="white-space:pre-wrap;word-break:break-word;margin:8px 0">${esc(text)}</pre><div class="bar"><button id="sVisCopy">Copy</button></div>`;
    $('#sVisCopy').onclick = () => copyText(text);
    b.disabled = false;
  };
  if ($('#sErrCopy')) $('#sErrCopy').onclick = () => copyText(errs.map(errorText).join('\n\n'));
  if ($('#sErrClear')) $('#sErrClear').onclick = () => { localStorage.removeItem(ERR_KEY); renderSettings(); };
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
function setTopActions() {
  const ta = $('#topActions');
  ta.innerHTML = '';
  if (S.tab === 'presets') {
    const b = h('<button class="primary">+ Reference</button>'); b.onclick = () => $('#pickRef').click();
    const l = h('<button>Import LR</button>'); l.onclick = () => $('#pickLR').click();
    ta.append(l, b);
  }
  if (S.tab === 'match' && visiblePhotos().some((p) => p.params)) {
    const list = () => visiblePhotos().filter((p) => p.params), n = list().length;
    const b = h(`<button class="primary">Export${n > 1 ? ` ${S.cullFilter === 'picks' ? 'picks' : 'all'} ${n}` : ''}</button>`); b.onclick = () => exportPhotos(list());
    ta.append(b);
  }
}

function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  for (const k of ['presets', 'match', 'settings']) $(`#view-${k}`).hidden = k !== t;
  $('#title').textContent = { presets: 'References', match: 'LookMatch', settings: 'Settings' }[t];
  setTopActions();
  if (t === 'presets') renderPresets();
  if (t === 'match') renderMatch();
  if (t === 'settings') renderSettings();
}

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$('#pickRef').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) newPresetFrom(f); };
$('#pickLR').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importLightroom(fs); };
$('#pickPhotos').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addPhotos(fs); };

(async function boot() {
  const r = drive.captureRedirect();
  await db.persist();
  await loadPresets();
  if (r?.ok) { toast('Google Drive connected'); setTab('match'); for (const p of S.presets) if (!p.driveId) backupPreset(p); }
  else if (r?.error) { toast(`Drive sign-in failed: ${r.error}`); setTab('settings'); }
  else setTab('match');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();

// for automated tests
window.__lm = { S, pool, addPhotos, newPresetFrom, exportPhotos, openDetail, solvePhoto, D: () => D };
