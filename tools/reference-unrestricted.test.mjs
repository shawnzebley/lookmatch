import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, measure } from '../engine/measure.js';
import { computeTargets, solve } from '../engine/solver.js';

function rampPixels(scale) {
  const width = 32, height = 32, data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(scale * (24 + 210 * i / (width * height - 1)));
    data.set([v, v, v, 255], i * 4);
  }
  return prepare({ width, height, channels: 4, data });
}
function ramp(scale) { return measure(rampPixels(scale)); }

test('full strength targets reference tone percentiles directly, including dark to bright matches', () => {
  const source = ramp(0.35), reference = ramp(1);
  const targets = computeTargets(source, reference);
  for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99]) assert.ok(Math.abs(targets.tone.pct[p] - reference.tone.pct[p]) < 1e-10);
  assert.ok(Math.abs(targets.anchor - reference.tone.pct[50]) < 1e-10);
});

test('zero strength preserves source targets; large supported color differences are not ratio capped', () => {
  const source = ramp(0.7), reference = structuredClone(source);
  for (const band of Object.keys(source.bands)) {
    reference.bands[band].weight = Math.max(0.02, source.bands[band].weight);
    reference.bands[band].hue = source.bands[band].hue + 120;
    reference.bands[band].chroma = source.bands[band].chroma + 30;
    reference.bands[band].lumRel = source.bands[band].lumRel + 40;
  }
  reference.color.meanChroma = source.color.meanChroma + 50;
  reference.color.lowChroma = source.color.lowChroma + 40;
  const zero = computeTargets(source, reference, { strength: 0 });
  const full = computeTargets(source, reference, { strength: 1 });
  assert.equal(zero.color.meanChroma, source.color.meanChroma);
  assert.equal(zero.tone.pct[50], source.tone.pct[50]);
  assert.equal(full.color.meanChroma, reference.color.meanChroma);
  assert.equal(full.color.lowChroma, reference.color.lowChroma);
  for (const band of Object.keys(source.bands)) if (full.bands[band]) {
    assert.equal(full.bands[band].chroma, reference.bands[band].chroma);
    assert.equal(full.bands[band].lumRel, reference.bands[band].lumRel);
  }
});

test('fitted controls can use the displayed exposure range beyond legacy solver caps', () => {
  const pixels = rampPixels(0.04), source = measure(pixels), reference = ramp(1);
  const result = solve(pixels, source, reference);
  assert.ok(result.params.exposure > 1.5, `expected exposure above old +1.5 solver cap, got ${result.params.exposure}`);
  assert.ok(result.params.exposure <= 3);
});

test('HSL dimensions with no measured band support stay at the minimum edit', () => {
  const pixels = rampPixels(0.7), source = measure(pixels);
  const reference = structuredClone(source);
  for (const band of Object.keys(reference.bands)) reference.bands[band].weight = 0;
  const result = solve(pixels, source, reference);
  for (const key of Object.keys(result.params)) {
    if (/^(hue|sat|lum)_/.test(key)) assert.equal(result.params[key], 0, `${key} has no supported target`);
  }
});
