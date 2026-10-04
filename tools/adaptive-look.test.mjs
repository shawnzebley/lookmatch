import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveLook, solveAdaptiveLook } from '../engine/adaptive-look.js';
import { prepare } from '../engine/measure.js';
import { processPixelSet } from '../engine/pipeline.js';

function pixels({ exposure = 0, warm = 0, skin = true } = {}) {
  const n = 300, data = new Uint8Array(n * 3), skinMask = new Uint8Array(n), skinPeople = new Uint8Array(n), subject = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const isSkin = i < 120, light = Math.min(1.2, Math.max(0.45, 0.7 + (i % 60) * 0.008)) * 2 ** (exposure / 30);
    const rgb = isSkin
      ? (i < 60 ? [Math.min(255, 180 * light + warm), Math.min(255, 116 * light), Math.min(255, 88 * light)] : [Math.min(255, 150 * light + warm), Math.min(255, 108 * light), Math.min(255, 104 * light)])
      : (i % 2 ? [55 * light, 108 * light, 174 * light] : [125 * light, 154 * light, 82 * light]);
    for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.round(Math.max(0, Math.min(255, rgb[c])));
    if (skin && isSkin) { skinMask[i] = 255; skinPeople[i] = i < 60 ? 1 : 2; }
    if (isSkin) subject[i] = 255;
  }
  const ps = prepare({ width: n, height: 1, channels: 3, data }, { skin: skin ? skinMask : null, subject });
  if (skin) { ps.skinMask = skinMask; ps.skinPeople = skinPeople; }
  return ps;
}

test('profiles retain distinct editable parameters and serialize deterministically', () => {
  const a = buildAdaptiveLook(pixels(), pixels({ warm: 8 }), { id: 'a', name: 'Warm' });
  const b = buildAdaptiveLook(pixels(), pixels({ exposure: 12 }), { id: 'b', name: 'Bright' });
  assert.notDeepEqual(a.params, b.params);
  assert.equal(a.version, 1);
  const repeat = buildAdaptiveLook(pixels(), pixels({ warm: 8 }), { id: 'a', name: 'Warm' });
  assert.equal(JSON.stringify(a), JSON.stringify(repeat));
  for (const key of ['curve', 'hue_orange', 'sat_orange', 'lum_orange', 'temp', 'exposure']) assert.ok(key in a.params);
  assert.equal('referenceTransfer' in a.params, false);
  assert.ok(Math.abs(a.targets.skin.a - (a.reference.skinAfter.a - a.reference.skinBefore.a)) < 1e-9);
  for (const key of ['curve', 'curveR', 'curveG', 'curveB']) {
    const points = a.params[key];
    assert.ok(points.every(([x, y]) => x >= 0 && x <= 255 && y >= 0 && y <= 255));
    assert.ok(points.length >= 2 && points.every(([x, y], i) => Number.isFinite(x) && Number.isFinite(y) && (!i || (x > points[i - 1][0] && y >= points[i - 1][1]))));
  }
});

test('amount zero returns an empty identity profile result without touching input', () => {
  const ps = pixels(), before = JSON.stringify([...ps.L, ...ps.A, ...ps.B]);
  const look = buildAdaptiveLook(pixels(), pixels({ warm: 4 }), { id: 'zero' });
  const result = solveAdaptiveLook(ps, look, { strength: 0 });
  assert.deepEqual(result.params, {});
  assert.equal(result.normalise.exposure, 0);
  assert.equal(JSON.stringify([...ps.L, ...ps.A, ...ps.B]), before);
});

test('per-image normalisation responds to image exposure and stays within profile limits', () => {
  const look = buildAdaptiveLook(pixels(), pixels({ warm: 4 }), { id: 'norm' });
  const a = solveAdaptiveLook(pixels({ exposure: -18 }), look);
  const b = solveAdaptiveLook(pixels({ exposure: 18 }), look);
  assert.notEqual(a.normalise.exposure, b.normalise.exposure);
  assert.ok(Math.abs(a.normalise.exposure) <= look.limits.normaliseExposure);
  assert.ok(Math.abs(b.normalise.temp) <= look.limits.normaliseTemp);
});

test('missing masks report the limit and all params remain finite', () => {
  const ps = pixels({ skin: false }), look = buildAdaptiveLook(pixels({ skin: false }), pixels({ skin: false, warm: 5 }), { id: 'nomask' });
  const result = solveAdaptiveLook(ps, look);
  assert.equal(result.adaptive.maskAvailable, false);
  assert.match(result.adaptive.warning, /unavailable/);
  for (const v of Object.values(result.params)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
});

test('skin correction is carried separately and leaves unmasked pixels unchanged', () => {
  const ps = pixels(), look = buildAdaptiveLook(pixels(), pixels({ warm: 4 }), { id: 'skin' });
  // A controlled profile delta ensures the synthetic mask has an observable correction.
  look.targets.skin = { L: 0, a: 6, b: -4, pixels: 0, version: 2, people: [{ id: 'profile', zones: {
    shadow: { L: 0, a: 6, b: -4 }, midtone: { L: 0, a: 6, b: -4 }, lit: { L: 0, a: 6, b: -4 },
  } }] };
  const result = solveAdaptiveLook(ps, look, { skinProtection: 1 });
  assert.ok(result.params.skinMatch);
  assert.deepEqual(result.params.skinMatch.people.map((p) => p.id).sort(), [1, 2]);
  const p1 = result.params.skinMatch.people.find((p) => p.id === 1), p2 = result.params.skinMatch.people.find((p) => p.id === 2);
  assert.ok(Math.abs(p1.zones[1].before.a - p2.zones[1].before.a) > 3, 'per-person source skin colors should remain distinct');
  const plain = { ...result.params }; delete plain.skinMatch;
  const a = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  const b = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  processPixelSet(ps, plain, null, a); processPixelSet(ps, result.params, null, b);
  assert.notEqual(a.A[10], b.A[10]);
  assert.equal(a.A[120], b.A[120]); assert.equal(a.B[120], b.B[120]);
});

test('small Amount scales normalisation, look controls, and skin correction toward identity', () => {
  const look = buildAdaptiveLook(pixels(), pixels({ warm: 9 }), { id: 'small' }), ps = pixels({ exposure: -18 });
  const almostZero = solveAdaptiveLook(ps, look, { strength: 0.001 });
  assert.ok(Math.abs(almostZero.normalise.exposure) < 0.002);
  assert.ok(Math.abs(almostZero.normalise.temp) < 0.1);
  assert.ok(Math.abs(almostZero.params.curveSaturation - 100) < 0.001);
  const output = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n), lr: new Float32Array(ps.n), lg: new Float32Array(ps.n), lb: new Float32Array(ps.n) };
  processPixelSet(ps, almostZero.params, null, output);
  const maxDelta = Math.max(...Array.from({ length: ps.n }, (_, i) => Math.hypot(output.L[i] - ps.L[i], output.A[i] - ps.A[i], output.B[i] - ps.B[i])));
  assert.ok(maxDelta < 1, `tiny Amount changed a pixel by ${maxDelta.toFixed(3)} Lab`);
});

test('background fitting uses this photo and stays inside its editable mask', () => {
  const look = buildAdaptiveLook(pixels(), pixels({ exposure: 8, warm: 4 }), { id: 'background' });
  const ps = pixels({ exposure: -12 });
  const result = solveAdaptiveLook(ps, look, { skinProtection: 0 });
  assert.ok(result.params.local?.background);
  assert.ok(result.adaptive.backgroundFitted);
  assert.ok(Math.abs(result.params.local.background.exposure) <= look.limits.backgroundExposure);
  const masked = processPixelSet(ps, result.params);
  const withoutLocal = { ...result.params }; delete withoutLocal.local;
  const global = processPixelSet(ps, withoutLocal);
  assert.equal(masked.L[10], global.L[10], 'background fitting cannot change the subject');
  assert.notEqual(masked.L[150], global.L[150], 'background fitting must affect background pixels');
  assert.ok(Math.abs(result.regions.background.target.mid - (look.reference.backgroundBefore.tone.pct[50] + look.targets.background.tone.pct[50])) > 1,
    'target must follow the current photo instead of copying the demo scene');
  const changedMask = { ...ps, subject: Uint8Array.from(ps.subject, (v, i) => i >= 180 ? 255 : v) };
  const revised = solveAdaptiveLook(changedMask, look, { skinProtection: 0 });
  const revisedPixels = processPixelSet(changedMask, revised.params);
  assert.notEqual(revisedPixels.L[200], masked.L[200], 'editing the mask must change which pixels receive the background correction');
});
