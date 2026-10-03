import test from 'node:test';
import assert from 'node:assert/strict';
import { labToLin } from '../engine/color.js';
import { referenceTransferStats, fitReferenceTransfer } from '../engine/reference-transfer.js';
import { defaultParams, processPixelSet } from '../engine/pipeline.js';

const neutral = labToLin(50, 0, 0, [0, 0, 0]);
function repeated(color, n = 32) {
  return { n, lr: Float64Array.from({ length: n }, () => color[0]),
    lg: Float64Array.from({ length: n }, () => color[1]), lb: Float64Array.from({ length: n }, () => color[2]) };
}
function makeTransform(a) {
  const source = referenceTransferStats(repeated(neutral));
  const reference = referenceTransferStats(repeated(labToLin(50, a, 0, [0, 0, 0])));
  return fitReferenceTransfer(source, reference);
}
function pixels() {
  return { n: 2, lr: Float64Array.from([neutral[0], neutral[0]]),
    lg: Float64Array.from([neutral[1], neutral[1]]), lb: Float64Array.from([neutral[2], neutral[2]]),
    L: new Float32Array([50, 50]), subject: Uint8Array.from([255, 0]) };
}

test('pipeline applies independent serializable subject and background transfers', () => {
  const p = defaultParams();
  p.local = { subject: { referenceTransfer: makeTransform(25) },
    background: { referenceTransfer: makeTransform(-25) } };
  const original = JSON.stringify(p);
  const first = processPixelSet(pixels(), p);
  assert.ok(first.A[0] > 10, `subject a* should move positive, got ${first.A[0]}`);
  assert.ok(first.A[1] < -10, `background a* should move negative, got ${first.A[1]}`);
  assert.equal(JSON.stringify(p), original, 'pipeline mutated the input params');

  const restored = JSON.parse(JSON.stringify(p));
  const again = processPixelSet(pixels(), restored);
  assert.deepEqual(Array.from(again.lr), Array.from(first.lr));
  assert.deepEqual(Array.from(again.lg), Array.from(first.lg));
  assert.deepEqual(Array.from(again.lb), Array.from(first.lb));
});

test('manual exposure remains active after reference transfer', () => {
  const p = defaultParams();
  p.referenceTransfer = makeTransform(20);
  const ps = pixels();
  const base = processPixelSet(ps, p);
  const adjusted = processPixelSet(ps, { ...p, exposure: 1 });
  assert.ok(adjusted.L[0] > base.L[0] + 10, `exposure change ${adjusted.L[0] - base.L[0]} was too small`);
});
