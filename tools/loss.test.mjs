import test from 'node:test';
import assert from 'node:assert/strict';
import { culprits } from '../engine/loss.js';
import { defaultParams } from '../engine/pipeline.js';

test('slider blame reverts to zero when no automatic baseline is supplied', () => {
  const ps = { n: 1, L: [70], lr: [0.5], lg: [0.4], lb: [0.3] };
  const params = { ...defaultParams(), exposure: 0.8 };
  const process = p => ({ L: [p.exposure ? 95 : 70], lr: [p.exposure ? 1 : 0.5], lg: [0.4], lb: [0.3] });
  const blamed = culprits(ps, params, process, [0], {}, ['exposure'], null);
  assert.equal(blamed[0].key, 'exposure');
  assert.ok(blamed[0].gain > 0);
});
