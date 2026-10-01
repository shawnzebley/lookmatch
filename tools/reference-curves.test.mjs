import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, measure } from '../engine/measure.js';
import { solve, computeTargets } from '../engine/solver.js';
import { processPixelSet } from '../engine/pipeline.js';

function gradient({ warmth = 0, contrast = 0 } = {}) {
  const width = 72, height = 72, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const v = Math.max(0, Math.min(255, Math.round(28 + 198 * (x + y) / (width + height - 2))));
    data[i] = Math.max(0, Math.min(255, v + warmth));
    data[i + 1] = v;
    data[i + 2] = Math.max(0, Math.min(255, v - warmth));
    data[i + 3] = 255;
  }
  return prepare({ width, height, channels: 4, data });
}

function channelDelta(curve) {
  return curve?.reduce((sum, [x, y]) => sum + y - x, 0) || 0;
}

test('reference p25 and p75 shape feed the measured tone targets and master curve', () => {
  const source = gradient(), refA = measure(gradient());
  // Change only the reference's middle quantiles to prove they are consumed by the target builder.
  const altered = structuredClone(refA);
  altered.tone.pct[25] -= 8; altered.tone.pct[75] += 8;
  const targetsA = computeTargets(refA, refA), targetsB = computeTargets(refA, altered);
  assert.notEqual(targetsA.tone.pct[25], targetsB.tone.pct[25]);
  assert.notEqual(targetsA.tone.pct[75], targetsB.tone.pct[75]);
  const a = solve(source, measure(source), refA);
  const b = solve(source, measure(source), altered);
  assert.notDeepEqual(a.params.curve, b.params.curve);
});

test('warm and cool references produce opposite channel curve directions', () => {
  const source = gradient(), o = measure(source);
  const warm = solve(source, o, measure(gradient({ warmth: 14 })));
  const cool = solve(source, o, measure(gradient({ warmth: -14 })));
  const warmBias = channelDelta(warm.params.curveR) - channelDelta(warm.params.curveB);
  const coolBias = channelDelta(cool.params.curveR) - channelDelta(cool.params.curveB);
  assert.ok(warmBias > 0, `warm curve bias ${warmBias}`);
  assert.ok(coolBias < 0, `cool curve bias ${coolBias}`);
});

test('self match and strength zero do not introduce RGB curves', () => {
  const source = gradient(), o = measure(source);
  const self = solve(source, o, o);
  const zero = solve(source, o, measure(gradient({ warmth: 20 })), { strength: 0 });
  for (const result of [self, zero]) {
    for (const key of ['curve', 'curveR', 'curveG', 'curveB']) {
      assert.ok(!result.params[key] || channelDelta(result.params[key]) === 0, `${key} should remain identity`);
    }
  }
});

test('RGB curve fitting stays inside target clipping budgets', () => {
  const source = gradient(), o = measure(source), ref = measure(gradient({ warmth: 35 }));
  const result = solve(source, o, ref);
  const after = measure(source, processPixelSet(source, result.params));
  assert.ok(after.tone.clipHi <= result.targets.clip.hi + 0.001);
  assert.ok(after.tone.clipLo <= result.targets.clip.lo + 0.001);
});
