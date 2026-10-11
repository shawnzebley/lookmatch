import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMaskPlane, detectSky, estimateLight, maskSpecKey, subjectBox } from '../engine/look-masks.js';
import { applyDetail, applyLookEffects, effectsHalo, hasLookEffects, hazeColor } from '../engine/effects.js';
import { compile, defaultParams } from '../engine/pipeline.js';
import { gradeWeights } from '../engine/measure.js';
import { kelvinToRelative } from '../engine/dynamic-preset.js';

// 64 x 48 scene: blue sky on top, a bright sun patch upper-left, dark ground below
function scene(w = 64, h = 48) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = (y * w + x) * 4;
    let c = y < h * 0.45 ? [90, 140, 215] : [60 + (x * 7 % 23), 70 + (y * 5 % 19), 40];
    if (Math.hypot(x - 10, y - 8) < 5) c = [255, 250, 235];
    data.set([...c, 255], j);
  }
  return { width: w, height: h, data };
}

test('sky is found on top and not on the ground', () => {
  const s = scene(), sky = detectSky(s);
  assert.ok(sky[2 * 64 + 40] > 0.8, 'sky');
  assert.ok(sky[40 * 64 + 40] < 0.1, 'ground');
});

test('no sky indoors (nothing smooth reaching the top)', () => {
  const w = 40, h = 30, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([40 + (i * 37 % 60), 35 + (i * 13 % 50), 30, 255], i * 4);
  const sky = detectSky({ width: w, height: h, data });
  assert.equal(Math.max(...sky), 0);
});

test('light lands on the bright side, people ignored', () => {
  const s = scene(), lt = estimateLight(s);
  assert.ok(lt.x < 0.4 && lt.y < 0.4, JSON.stringify(lt));
  const person = new Uint8Array(64 * 48);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) if (Math.hypot(x - 10, y - 8) < 8) person[y * 64 + x] = 255;
  const lt2 = estimateLight(s, person);
  assert.ok(Math.hypot(lt2.x - 10 / 64, lt2.y - 8 / 48) > 0.05, 'bright person is not the light');
});

test('mask planes: edges, radial on the light, eyes, skin, whole photo', () => {
  const w = 64, h = 48, s = scene();
  const bottom = buildMaskPlane({ kind: 'linear', from: 'bottom', extent: 0.3 }, w, h, {}).plane;
  assert.equal(bottom[(h - 1) * w + 5] > 240, true); assert.equal(bottom[5], 0);
  const right = buildMaskPlane({ kind: 'linear', from: 'right', extent: 0.1 }, w, h, {}).plane;
  assert.ok(right[10 * w + w - 1] > 200 && right[10 * w + 30] === 0);
  const rad = buildMaskPlane({ kind: 'radial', anchor: 'light', rx: 0.2, ry: 0.2, feather: 0.5 }, w, h, { small: s });
  assert.ok(rad.placed.x < 0.4 && rad.plane[8 * w + 10] > 200 && rad.plane[40 * w + 60] === 0);
  const eyes = buildMaskPlane({ kind: 'eyes' }, w, h, { faces: [{ eyes: [[0.5, 0.5, 0.05]] }] }).plane;
  assert.ok(eyes[24 * w + 32] > 200 && eyes[5 * w + 5] === 0);
  const skin = new Uint8Array(w * h).fill(7);
  assert.equal(buildMaskPlane({ kind: 'skin' }, w, h, { skin }).plane[100], 7);
  assert.equal(buildMaskPlane({ kind: 'all' }, w, h, {}).frac, 1);
  const person = new Uint8Array(w * h);
  for (let y = 10; y < 40; y++) for (let x = 40; x < 56; x++) person[y * w + x] = 255;
  const sb = subjectBox(person, w, h);
  assert.ok(Math.abs(sb.x - 48 / 64) < 0.02 && Math.abs(sb.y - 25 / 48) < 0.02);
  assert.equal(maskSpecKey([{ kind: 'sky', adj: { exposure: 1 } }]), maskSpecKey([{ kind: 'sky', adj: { exposure: -1 } }]), 'adjustments do not move masks');
});

function flatImage(w, h, f) { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...f(x, y), 255], (y * w + x) * 4); return d; }
const lumaStd = (d, n) => { let s = 0, s2 = 0; for (let i = 0; i < n; i++) { const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; s += v; s2 += v * v; } return Math.sqrt(s2 / n - (s / n) ** 2); };

test('texture and clarity: + adds local contrast, - removes it', () => {
  const w = 80, h = 60, n = w * h, src = flatImage(w, h, (x, y) => { const v = 128 + 30 * Math.sin(x / 2) * Math.cos(y / 3); return [v, v, v]; });
  const base = lumaStd(src, n);
  for (const key of ['texture', 'clarity']) {
    const up = Uint8ClampedArray.from(src), down = Uint8ClampedArray.from(src);
    applyDetail(up, w, h, { [key]: 60 }, null, 400); applyDetail(down, w, h, { [key]: -60 }, null, 400);
    assert.ok(lumaStd(up, n) > base + 0.5, `${key} +`); assert.ok(lumaStd(down, n) < base - 0.5, `${key} -`);
  }
  const masked = Uint8ClampedArray.from(src), weight = new Uint8Array(n);
  applyDetail(masked, w, h, { texture: -100 }, weight, 400);
  assert.deepEqual(masked, src, 'zero weight leaves pixels alone');
});

test('dehaze: + deepens a hazy photo, - lifts it toward the haze colour', () => {
  const w = 60, h = 40, n = w * h, src = flatImage(w, h, (x) => [150 + x, 160 + x, 170 + x]);
  const A = hazeColor(src, n);
  const plus = Uint8ClampedArray.from(src), minus = Uint8ClampedArray.from(src);
  applyDetail(plus, w, h, { dehaze: 50 }, null, 300, A); applyDetail(minus, w, h, { dehaze: -50 }, null, 300, A);
  const mean = (d) => { let s = 0; for (let i = 0; i < n; i++) s += d[i * 4 + 1]; return s / n; };
  assert.ok(mean(plus) < mean(src) - 2, 'darker, less veiled'); assert.ok(mean(minus) > mean(src) + 1, 'more veiled');
});

test('look masks mix their own adjustments in only where the mask is', () => {
  const w = 40, h = 20, n = w * h, src = flatImage(w, h, () => [100, 100, 100]);
  const p = { ...defaultParams(), lookMasks: [{ kind: 'linear', adj: { exposure: 1 } }] };
  const out = Uint8ClampedArray.from(src), plane = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) plane[y * w + x] = 255;
  assert.ok(hasLookEffects(p));
  applyLookEffects(out, src, w, h, p, { long: 40, planes: [plane] });
  assert.equal(out[(5 * w + 5) * 4], 100);
  assert.ok(out[(5 * w + 30) * 4] > 130);
  assert.ok(effectsHalo(4000) > effectsHalo(1000));
});

test('grade blending 50 (Lightroom default) keeps the old weights; lower narrows, higher widens', () => {
  const old = (L) => { const x = L / 100, s = (a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }; const ws = 1 - s(0.12, 0.5), wh = s(0.5, 0.88); return [ws, Math.max(0, 1 - ws - wh), wh]; };
  for (const L of [10, 30, 50, 70, 90]) assert.deepEqual(gradeWeights(L, 0, [0, 0, 0], 0.5).map((v) => +v.toFixed(6)), old(L).map((v) => +v.toFixed(6)));
  assert.ok(gradeWeights(22, 0, [0, 0, 0], 0)[0] > gradeWeights(22, 0, [0, 0, 0], 0.5)[0]);
  assert.ok(gradeWeights(45, 0, [0, 0, 0], 1)[0] > gradeWeights(45, 0, [0, 0, 0], 0.5)[0]);
  const a = compile({ ...defaultParams(), shadowHue: 220, shadowSat: 60 }), b = compile({ ...defaultParams(), shadowHue: 220, shadowSat: 60, gradeBlending: 0 });
  const ra = new Float64Array(6), rb = new Float64Array(6);
  a(0.06, 0.06, 0.06, ra); b(0.06, 0.06, 0.06, rb);
  assert.notDeepEqual([...ra], [...rb]);
});

test('Kelvin: daylight is neutral, higher Kelvin warms', () => {
  assert.deepEqual(kelvinToRelative(5500, 10), { temp: 0, tint: 0 });
  assert.ok(kelvinToRelative(6500, 10).temp > 20);
  assert.ok(kelvinToRelative(4500, 10).temp < -20);
});
