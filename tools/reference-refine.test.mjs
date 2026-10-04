import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, measure } from '../engine/measure.js';
import { defaultParams, buildLUTs, applyLUTs, compile } from '../engine/pipeline.js';
import { computeTargets } from '../engine/solver.js';
import { applySkinMatchRGBA, skinStats } from '../engine/skin-match.js';
import { refineReference } from '../engine/reference-refine.js';

function fixture() {
  const width = 24, height = 24, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = 70 + i % 80;
    data.set([v + 25, v, v - 15, 255], i * 4);
  }
  const image = { width, height, data }, ps = prepare(image);
  ps.skinMask = new Uint8Array(ps.n).fill(255);
  return { image, ps, render: (params) => {
    const out = new Uint8ClampedArray(data.length);
    applyLUTs(buildLUTs(params, 33), null, data, out, ps.n, 4, 4);
    if (params.skinMatch) applySkinMatchRGBA(out, params.skinMatch, ps.skinMask, 4, null, data);
    return prepare({ width, height, data: out });
  } };
}

test('rendered refinement improves tone/color after a drifting rendered edit', () => {
  const { ps, render } = fixture(), stats = measure(ps);
  const params = { ...defaultParams(), exposure: 0.35, temp: 8, saturation: 10 };
  const result = refineReference(ps, params, computeTargets(stats, stats), render);
  assert.ok(result.refinement.after < result.refinement.before, JSON.stringify(result.refinement));
  assert.equal(params.exposure, 0.35, 'caller settings remain intact');
  assert.ok(result.refinement.evaluations <= 30, 'runtime is bounded');
});

test('skin target is fitted after tone changes and follows selected strength from original', () => {
  const { ps, render } = fixture(), stats = measure(ps), original = skinStats(ps);
  const target = { ...original, L: original.L - 20, a: original.a + 3, b: original.b + 4 };
  const result = refineReference(ps, { ...defaultParams(), exposure: 0.3 }, computeTargets(stats, stats), render,
    { skinTarget: target, strength: 0.5, passes: 0 });
  const actual = skinStats(ps, render(result.params));
  assert.ok(Math.abs(actual.L - (original.L - 10)) < 1, `skin L ${actual.L}, original ${original.L}`);
  assert.ok(Math.abs(actual.a - (original.a + 1.5)) < 1);
});

test('skin correction amount can differ from the lighting match amount', () => {
  const { ps, render } = fixture(), stats = measure(ps), original = skinStats(ps);
  const target = { ...original, L: original.L - 20, a: original.a + 4, b: original.b + 4 };
  const result = refineReference(ps, { ...defaultParams(), exposure: 0.3 }, computeTargets(stats, stats), render,
    { skinTarget: target, strength: 1, skinStrength: 0.25, passes: 0 });
  const actual = skinStats(ps, render(result.params));
  assert.ok(Math.abs(actual.L - (original.L - 5)) < 1);
  assert.ok(Math.abs(actual.a - (original.a + 1)) < 1);
});

test('entering the curve domain preserves bright saturated colors instead of clipping each channel', () => {
  const params = { ...defaultParams(), exposure: 1 };
  const base = compile(params)(0.8, 0.3, 0.12, new Array(6).fill(0));
  const curved = compile({ ...params, curve: [[0, 0], [128, 128.0001], [255, 255]] })(0.8, 0.3, 0.12, new Array(6).fill(0));
  assert.ok(Math.hypot(...curved.slice(3).map((v, i) => v - base[i + 3])) < 0.05);
  assert.ok(curved.slice(0, 3).every(v => v >= 0 && v <= 1));
});

test('already-matching skin retains explicit correspondence without adding a correction', () => {
  const { ps } = fixture();
  ps.skinPeople = new Uint8Array(ps.n).fill(1);
  const target = skinStats(ps), stats = measure(ps);
  const result = refineReference(ps, defaultParams(), computeTargets(stats, stats), () => ps,
    { skinTarget: target, passes: 0 });
  assert.equal(result.params.skinMatch.version, 2);
  assert.equal(result.params.skinMatch.people[0].referenceId, 1);
  for (const zone of result.params.skinMatch.people[0].zones)
    for (const key of ['deltaL', 'deltaA', 'deltaB']) assert.equal(zone[key], 0);
});
