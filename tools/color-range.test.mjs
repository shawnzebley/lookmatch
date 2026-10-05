import test from 'node:test';
import assert from 'node:assert/strict';
import { colorRangeWeight, rgbToHsl } from '../engine/color-range.js';
import { compile, defaultParams } from '../engine/pipeline.js';
import { srgbToLinear, linToLab } from '../engine/color.js';

const range = { h: 2, s: 80, l: 50, hueWidth: 20, satWidth: 25, lightWidth: 20, softness: 0.5 };

test('picked HSL range includes its center and rejects colors outside any radius', () => {
  assert.equal(colorRangeWeight({ h: 2, s: 80, l: 50 }, range), 1);
  assert.equal(colorRangeWeight({ h: 2, s: 80, l: 50 }, { ...range, h: 202 }), 0);
  assert.equal(colorRangeWeight({ h: 2, s: 20, l: 50 }, range), 0);
});

test('hue membership wraps around zero degrees', () => {
  assert.ok(colorRangeWeight({ h: 357, s: 80, l: 50 }, range) > 0);
  assert.ok(colorRangeWeight({ h: 345, s: 80, l: 50 }, range) > 0);
  assert.equal(colorRangeWeight({ h: 340, s: 80, l: 50 }, range), 0);
});

test('soft edges fade smoothly to zero at the selection boundary', () => {
  const near = colorRangeWeight({ h: 17, s: 80, l: 50 }, range);
  const edge = colorRangeWeight({ h: 22, s: 80, l: 50 }, range);
  assert.ok(near > edge);
  assert.equal(edge, 0);
});

test('RGB sample conversion returns HSL percentages', () => {
  assert.deepEqual(rgbToHsl([1, 0, 0]), { h: 0, s: 100, l: 50 });
  assert.deepEqual(rgbToHsl([0.5, 0.5, 0.5]), { h: 0, s: 0, l: 50 });
});

test('unselected legacy point colors retain unfiltered membership', () => {
  assert.equal(colorRangeWeight([0, 1, 0], null), 1);
});

test('picked point edits use original source HSL and leave outside colors unchanged', () => {
  const base = defaultParams();
  const sample = [0.8, 0.08, 0.08];
  const lab = [0, 0, 0];
  linToLab(...sample.map(srgbToLinear), lab);
  const point = { L: lab[0], a: lab[1], b: lab[2], hue: 50, sat: 0, lum: 0,
    selection: { ...rgbToHsl(sample), hueWidth: 15, satWidth: 20, lightWidth: 20, softness: 0.3 } };
  const process = compile({ ...base, points: [point] });
  const inResult = process(...sample.map(srgbToLinear), new Float64Array(6));
  const outside = [0.08, 0.72, 0.12].map(srgbToLinear);
  const outResult = process(...outside, new Float64Array(6));
  const baseline = compile(base)(...outside, new Float64Array(6));
  assert.ok(Math.abs(inResult[4] - lab[1]) > 1);
  assert.deepEqual([...outResult.slice(0, 3)], [...baseline.slice(0, 3)]);
});
