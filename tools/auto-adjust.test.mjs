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
assert.ok(sk.auto && sk.hue < 0 && sk.sat > 0 && Math.abs(sk.hue) <= 60 && sk.sat <= 50);
assert.equal(lookSkinPoint({ L: 60, a: 15, b: 20 }, { hue: 53.13, chroma: 25 }), null);
// skin: with the look's skin brightness known, luminance closes the gap too
const sk2 = lookSkinPoint({ L: 50, a: 15, b: 20 }, { hue: 53.13, chroma: 25, lum: 58 });
assert.ok(sk2.lum > 0 && sk2.lum <= 50);
// bands: every colour with a gap gets HSL sliders (no picked point), red and orange left to the skin point when there is skin
const own = { red: { weight: 0.1, hue: 25, chroma: 30, lum: 50, lumRel: 0 }, orange: { weight: 0.3, hue: 55, chroma: 25, lum: 60, lumRel: 5 }, blue: { weight: 0.2, hue: -70, chroma: 30, lum: 40, lumRel: -15 }, green: { weight: 0.05, hue: 130, chroma: 20, lum: 50, lumRel: -5 } };
const tgt = { red: { weight: 0.1, hue: 35, chroma: 40, lum: 50, lumRel: 0 }, orange: { weight: 0.3, hue: 40, chroma: 40, lum: 60, lumRel: 5 }, blue: { weight: 0.2, hue: -60, chroma: 18, lum: 40, lumRel: -20 }, green: { weight: 0.05, hue: 120, chroma: 12, lum: 50, lumRel: -5 } };
const lb = lookBands(own, tgt);
assert.equal(lb.point, null);
assert.ok(lb.hsl.sat_blue < 0 && lb.hsl.sat_green < 0 && lb.hsl.lum_blue < 0);
assert.ok(!Object.keys(lb.hsl).some((k) => k.endsWith('orange') || k.endsWith('red')));
assert.ok(lookBands(own, tgt, { skin: false }).hsl.sat_orange > 0);
assert.deepEqual(lookBands({}, {}), { point: null, hsl: {} });
// intensity
assert.ok(lookPresence(20, 12).vibrance < 0 && lookPresence(20, 30).vibrance > 0);
assert.equal(lookPresence(0, 12), null);
console.log('look-chasing checks passed');

import { sCurvePush, S_MIN, S_MAX } from '../engine/auto-adjust.js';
// the master curve always gets an S: never under S_MIN, more for a flat photo or a punchier look, capped at S_MAX
assert.equal(sCurvePush(140), S_MIN);
assert.ok(sCurvePush(60) > sCurvePush(85) && sCurvePush(10) === S_MAX);
assert.ok(sCurvePush(90, 120) > sCurvePush(90, null));
console.log('s-curve checks passed');
