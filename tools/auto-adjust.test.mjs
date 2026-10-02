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

import { fadeFor, skinPoint, lookColor } from '../engine/auto-adjust.js';
// fade scales with measured clipping
assert.deepEqual(fadeFor({ clipLo: 0, clipHi: 0, p5: 12, p99: 90 }), { fadeBlacks: 4, fadeWhites: 2 });
assert.ok(fadeFor({ clipLo: 0.01, clipHi: 0.01, p5: 1, p99: 99 }).fadeBlacks > 4);
assert.ok(fadeFor({ clipLo: 0.01, clipHi: 0.01, p5: 1, p99: 99 }).fadeWhites > 2);
// skin point: pale/dark skin gets a small, flagged move; healthy mid skin gets none
const pale = skinPoint(50, 10, 10);
assert.ok(pale.auto && pale.sat > 0 && pale.lum > 0 && Math.abs(pale.hue) <= 15);
assert.equal(skinPoint(65, 15, 20), null);
assert.equal(skinPoint(65, 1, 1), null);
// look colour: the strongest non-skin band gets the picked point, other present bands get HSL, skin bands untouched
const lc = lookColor({ orange: { weight: 0.3, hue: 55, chroma: 25, lum: 60 }, blue: { weight: 0.2, hue: -60, chroma: 30, lum: 40 }, green: { weight: 0.05, hue: 130, chroma: 20, lum: 50 } });
assert.ok(lc.point.auto && lc.point.sat > 0 && Math.abs(lc.point.L - 40) < 1e-9);
assert.deepEqual(lc.hsl, { sat_green: -10, lum_green: -4 });
assert.deepEqual(lookColor({}), { point: null, hsl: {} });
console.log('look rule checks passed');
