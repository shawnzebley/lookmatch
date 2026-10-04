import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, measure } from '../engine/measure.js';
import { adaptiveAppearanceChecks, addAdaptiveAppearanceChecks } from '../engine/adaptive-check.js';
import { referenceRegionTargets } from '../engine/masked-reference.js';

function image(scale = 1) {
  const data = new Uint8Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    const rgb = [[180, 40, 30], [30, 70, 180], [40, 150, 60], [130, 130, 130]][i % 4];
    for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.round(rgb[c] * scale);
  }
  return prepare({ width: 20, height: 20, channels: 3, data });
}

test('final appearance checks detect wrong lighting and measure supported reds, blues and greens', () => {
  const ps = image(), reference = measure(ps);
  const good = adaptiveAppearanceChecks(ps, ps, reference);
  assert.ok(good.filter(c => c.key.includes('adaptive-tone')).every(c => c.status === 'pass'));
  for (const band of ['red', 'blue', 'green']) assert.ok(good.some(c => c.key === `adaptive-band:${band}:hue` && c.status === 'pass'));
  const bad = adaptiveAppearanceChecks(ps, image(0.5), reference);
  assert.ok(bad.some(c => c.key.startsWith('adaptive-tone') && c.status === 'fail'));
});

test('missing reference color support is unverified rather than a successful match', () => {
  const ps = image(), reference = structuredClone(measure(ps));
  reference.bands.red.weight = 0;
  reference.bandsBg.red.weight = 0;
  if (reference.bandsAdaptive) reference.bandsAdaptive.red.weight = 0;
  const checks = adaptiveAppearanceChecks(ps, ps, reference);
  assert.ok(checks.some(c => c.key === 'adaptive-band:red' && c.status === 'unverified'));
  const acceptance = addAdaptiveAppearanceChecks({ checks: [], safetyPassed: true }, checks);
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.status, 'unverified');
});

test('checks follow Amount and cannot turn a failed skin check into a pass', () => {
  const ps = image(), reference = measure(image(0.5));
  const checks = adaptiveAppearanceChecks(ps, ps, reference, { strength: 0 });
  assert.ok(checks.every(c => c.status === 'pass'));
  const result = addAdaptiveAppearanceChecks({ checks: [{ key: 'skin', status: 'fail', reason: 'Wrong skin color' }] }, checks);
  assert.equal(result.status, 'rejected');
  assert.equal(result.accepted, false);
});

test('regional checks use each region rather than accepting a matching overall histogram', () => {
  const ps = image();
  ps.subject = Uint8Array.from({ length: ps.n }, (_, i) => i < 200 ? 255 : 0);
  const reference = measure(ps);
  reference.maskedRegions = referenceRegionTargets(ps);
  const cur = image();
  for (let i = 0; i < cur.n; i++) cur.L[i] += i < 200 ? 10 : -10;
  const checks = adaptiveAppearanceChecks(ps, cur, reference);
  assert.ok(checks.some(c => c.key.startsWith('subject:adaptive-tone') && c.status === 'fail'));
  assert.ok(checks.some(c => c.key.startsWith('background:adaptive-tone') && c.status === 'fail'));
});
