import test from 'node:test';
import assert from 'node:assert/strict';
import { srgbToLinear } from '../engine/color.js';
import { rgbToHsl } from '../engine/color-range.js';
import { referenceRangeSupport } from '../engine/reference-color-range.js';
import { referenceTransferStats, fitReferenceTransfer, applyReferenceTransferLinear } from '../engine/reference-transfer.js';
import { defaultParams, compile } from '../engine/pipeline.js';

const green = [20, 110, 70].map(v => v / 255);
const selection = { ...rgbToHsl(green), hueWidth: 18, satWidth: 20, lightWidth: 20, softness: 0.25, region: 'all' };
function pixels(rgb, n = 400) {
  const lin = rgb.map(srgbToLinear);
  return { n, lr: new Float32Array(n).fill(lin[0]), lg: new Float32Array(n).fill(lin[1]), lb: new Float32Array(n).fill(lin[2]) };
}
const sample = rgb => { const hsl = rgbToHsl(rgb); return [hsl.h, hsl.s, hsl.l]; };
const samples = (rgb, n = 400) => Array.from({ length: n }, () => sample(rgb));
const same = (actual, expected) => actual.slice(0, 3).forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-5));

test('reference matching requires selected hue, saturation and lightness support', () => {
  assert.equal(referenceRangeSupport(selection, samples(green)).supported, true);
  for (const rgb of [[0.9, 0.9, 0.9], [0.1, 0.3, 0.8], [0.3, 0.32, 0.31], [0.6, 0.95, 0.8]]) {
    assert.equal(referenceRangeSupport(selection, samples(rgb)).supported, false);
  }
});

test('tiny incidental reference overlap does not authorize a match', () => {
  const colors = samples([0.9, 0.9, 0.9], 2048);
  for (let i = 0; i < 20; i++) colors[i] = sample(green);
  assert.equal(referenceRangeSupport(selection, colors).supported, false);
  for (let i = 20; i < 40; i++) colors[i] = sample(green);
  const support = referenceRangeSupport(selection, colors);
  // Mutating samples is not a supported operation; references are immutable measured targets.
  const updated = referenceRangeSupport(selection, colors.slice());
  assert.equal(updated.supported, true);
  assert.ok(updated.weight > 0 && updated.weight < 1);
  assert.equal(support.supported, false);
});

test('missing saved-reference samples conservatively skip range matching', () => {
  assert.equal(referenceRangeSupport(selection, undefined).available, false);
  const source = referenceTransferStats(pixels(green));
  const reference = { ...source, colorSamples: undefined };
  const transfer = fitReferenceTransfer(source, reference, { preserveColors: true });
  same(applyReferenceTransferLinear(...green.map(srgbToLinear), transfer, undefined, selection), green.map(srgbToLinear));
});

test('unsupported reference and colors outside the selection remain original', () => {
  const source = referenceTransferStats(pixels(green));
  const neutral = referenceTransferStats(pixels([0.9, 0.9, 0.9]));
  const tr = fitReferenceTransfer(source, neutral, { preserveColors: true });
  same(applyReferenceTransferLinear(...green.map(srgbToLinear), tr, undefined, selection), green.map(srgbToLinear));
  const corresponding = referenceTransferStats(pixels([0.08, 0.5, 0.31]));
  const matched = fitReferenceTransfer(source, corresponding, { preserveColors: true });
  const blue = [0.1, 0.3, 0.8].map(srgbToLinear);
  same(applyReferenceTransferLinear(...blue, matched, undefined, selection), blue);
  const changed = applyReferenceTransferLinear(...green.map(srgbToLinear), matched, undefined, selection);
  assert.ok(Math.abs(changed[1] - srgbToLinear(green[1])) > 0.005);
});

test('sample reservoir is bounded, deterministic, and respects regional mask', () => {
  const ps = pixels(green, 4096);
  ps.mask = Uint8Array.from({ length: ps.n }, (_, i) => i < 200 ? 255 : 0);
  const a = referenceTransferStats(ps), b = referenceTransferStats(ps);
  assert.equal(a.colorSamples.length, 2048);
  assert.deepEqual(a.colorSamples, b.colorSamples);
  assert.equal(referenceTransferStats(ps, { mask: ps.mask }).colorSamples.length, 200);
});

test('manual HSL uses original membership even after exposure changes, and leaves outside colors alone', () => {
  const point = { L: 40, a: -30, b: 15, selection, hue: 0, sat: -50, lum: 0, range: 50 };
  const base = { ...defaultParams(), exposure: 1.5 };
  const original = compile(base), adjusted = compile({ ...base, points: [point] });
  const before = new Float64Array(6), after = new Float64Array(6);
  original(...green.map(srgbToLinear), before);
  adjusted(...green.map(srgbToLinear), after);
  assert.ok(Math.hypot(after[4], after[5]) < Math.hypot(before[4], before[5]) * 0.65);
  for (const rgb of [[0.1, 0.3, 0.8], [0.7, 0.7, 0.7]]) {
    original(...rgb.map(srgbToLinear), before);
    adjusted(...rgb.map(srgbToLinear), after);
    same(after, before);
  }
});

test('range gating survives JSON recipe roundtrip', () => {
  const source = referenceTransferStats(pixels(green));
  const reference = referenceTransferStats(pixels([0.08, 0.5, 0.31]));
  const params = { ...defaultParams(), referenceColorRange: selection,
    referenceTransfer: fitReferenceTransfer(source, reference, { preserveColors: true }) };
  const a = new Float64Array(6), b = new Float64Array(6);
  compile(params)(...green.map(srgbToLinear), a);
  compile(JSON.parse(JSON.stringify(params)))(...green.map(srgbToLinear), b);
  same(a, b);
});
