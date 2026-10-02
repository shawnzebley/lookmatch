import assert from 'node:assert/strict';
import { autoAdjustResult } from '../engine/auto-adjust.js';

// a reference match is recalculated toward the look, not preserved
const calculated = { exposure: 0.1, highlights: -1, curve: [[0, 0], [255, 255]] };
assert.deepEqual(autoAdjustResult({ curveAuto: 'reference', curve: [[0, 0], [128, 141], [255, 255]] }, calculated), { ...calculated, preservedReference: false });
assert.deepEqual(autoAdjustResult({}, calculated), { ...calculated, preservedReference: false });
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

import { lookFade, lookSkinPoint, lookBands, lookPresence } from '../engine/auto-adjust.js';
// fade moves only toward the look's ends
assert.deepEqual(lookFade({ p1: 2, p99: 98, clipLo: 0, clipHi: 0 }, { p1: 10, p99: 90 }), { fadeBlacks: 32, fadeWhites: 32 });
assert.deepEqual(lookFade({ p1: 12, p99: 85, clipLo: 0, clipHi: 0 }, { p1: 4, p99: 90 }), { fadeBlacks: 0, fadeWhites: 0 });
assert.equal(lookFade({ p1: 12, p99: 85, clipLo: 0.01, clipHi: 0 }, { p1: 4, p99: 90 }).fadeBlacks, 6);
assert.equal(lookFade({ p1: 2, p99: 98 }, null), null);
// skin: rotate and saturate toward the look's skin, small and capped
const sk = lookSkinPoint({ L: 60, a: 12, b: 22 }, { hue: 45, chroma: 30 });
assert.ok(sk.auto && sk.hue < 0 && sk.sat > 0 && Math.abs(sk.hue) <= 35 && sk.sat <= 30);
assert.equal(lookSkinPoint({ L: 60, a: 15, b: 20 }, { hue: 53.13, chroma: 25 }), null);
// bands: the biggest move becomes the picked point, the rest HSL, skin bands never touched
const lb = lookBands(
  { orange: { weight: 0.3, hue: 55, chroma: 25, lum: 60, lumRel: 5 }, blue: { weight: 0.2, hue: -70, chroma: 30, lum: 40, lumRel: -15 }, green: { weight: 0.05, hue: 130, chroma: 20, lum: 50, lumRel: -5 } },
  { orange: { weight: 0.3, hue: 40, chroma: 40, lum: 60, lumRel: 5 }, blue: { weight: 0.2, hue: -60, chroma: 18, lum: 40, lumRel: -20 }, green: { weight: 0.05, hue: 120, chroma: 12, lum: 50, lumRel: -5 } },
);
assert.ok(lb.point.auto && lb.point.sat < 0);
assert.ok(!Object.keys(lb.hsl).some((k) => k.endsWith('orange')) && lb.hsl.sat_green < 0);
assert.deepEqual(lookBands({}, {}), { point: null, hsl: {} });
// intensity
assert.ok(lookPresence(20, 12).vibrance < 0 && lookPresence(20, 30).vibrance > 0);
assert.equal(lookPresence(0, 12), null);
console.log('look-chasing checks passed');

import { colorContrast } from '../engine/auto-adjust.js';
// warm highlights over cool shadows: a flat-cast photo gets both wheels, one that already has the split gets none
const flat = colorContrast({ shadows: { b: 1, mass: 0.3 }, highlights: { b: 2, mass: 0.2 } });
assert.equal(flat.shadowHue, 225); assert.equal(flat.highlightHue, 40);
assert.ok(flat.shadowSat > 0 && flat.shadowSat <= 12 && flat.highlightSat > 0 && flat.highlightSat <= 8 && flat.shadowSat > flat.highlightSat);
assert.deepEqual(colorContrast({ shadows: { b: -2, mass: 0.3 }, highlights: { b: 3, mass: 0.2 } }), {});
// a nearly empty zone or missing measurements: leave the wheels alone
assert.deepEqual(colorContrast({ shadows: { b: 0, mass: 0.005 }, highlights: { b: 0, mass: 0.3 } }), {});
assert.deepEqual(colorContrast({}), {});
console.log('colour contrast checks passed');
