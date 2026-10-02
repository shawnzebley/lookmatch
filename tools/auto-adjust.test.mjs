import assert from 'node:assert/strict';
import { autoAdjustResult } from '../engine/auto-adjust.js';

const matched = {
  exposure: 0.2,
  curveAuto: 'reference',
  curve: [[0, 0], [128, 141], [255, 255]],
  curveR: [[0, 0], [128, 132], [255, 255]],
  local: { subject: { curveAuto: 'reference', curve: [[0, 0], [128, 120], [255, 255]] } },
};
assert.deepEqual(autoAdjustResult(matched), { ...matched, preservedReference: true });

const calculated = { exposure: 0.1, highlights: -1, curve: [[0, 0], [255, 255]] };
assert.deepEqual(autoAdjustResult({}, calculated), { ...calculated, preservedReference: false });
assert.deepEqual(autoAdjustResult({ local: { subject: { curveAuto: 'reference' } } }), {
  local: { subject: { curveAuto: 'reference' } }, preservedReference: true,
});
console.log('auto-adjust checks passed');

import { skinWhiteBalance, presenceFor, highlightRollOff } from '../engine/auto-adjust.js';
// natural skin (hue ~53 deg) is left alone; green/yellow skin gets magenta + a little blue; red skin gets a little green
assert.deepEqual(skinWhiteBalance(15, 20), { temp: 0, tint: 0 });
const green = skinWhiteBalance(8, 22);
assert.ok(green.tint > 0 && green.temp < 0 && green.tint <= 6 && green.temp >= -4);
assert.ok(skinWhiteBalance(24, 12).tint < 0);
assert.deepEqual(skinWhiteBalance(NaN, 5), { temp: 0, tint: 0 });
// saturation down, vibrance up (less for vivid photos)
assert.equal(presenceFor(15).saturation, -4);
assert.ok(presenceFor(15).vibrance > presenceFor(35).vibrance);
// highlights come down only when exposure goes up
assert.equal(highlightRollOff(0), 0);
assert.equal(highlightRollOff(-0.3), 0);
assert.ok(highlightRollOff(0.5) > highlightRollOff(0.2) && highlightRollOff(0.6) <= 12);
console.log('portrait rule checks passed');
