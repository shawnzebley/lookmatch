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
