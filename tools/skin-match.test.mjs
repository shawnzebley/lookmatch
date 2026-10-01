import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkinMatchLinear, applySkinMatchRGBA, fitSkinMatch, skinStats } from '../engine/skin-match.js';
import { SRGB8_TO_LIN, linearToSrgb, labToLin } from '../engine/color.js';

const rgbFor = (L, a, b) => labToLin(L, a, b, [0, 0, 0]);
const makePs = (n = 30, lab = [55, 12, 18]) => {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  L.fill(lab[0]); A.fill(lab[1]); B.fill(lab[2]);
  return { n, L, A, B, skinMask: new Uint8Array(n).fill(255) };
};
const error = (a, b) => Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);

test('fit moves a warmer, darker target toward its Lab values', () => {
  const ps = makePs();
  const target = { L: 45, a: 13, b: 27, pixels: 30 };
  const p = fitSkinMatch(ps, ps, target);
  const r = rgbFor(55, 12, 18);
  const out = [r[0], r[1], r[2], 0, 0, 0];
  applySkinMatchLinear(out, { skinMatch: p }, 255);
  const after = { L: out[3], a: out[4], b: out[5] };
  assert.ok(error(after, target) < error({ L: 55, a: 12, b: 18 }, target));
  assert.ok(after.L < 55 && after.b > 18);
});

test('stats use only confident mask pixels and robust medians', () => {
  const ps = makePs(25);
  ps.skinMask[24] = 80; ps.L[0] = 99; ps.A[0] = 90; ps.B[0] = -90;
  assert.deepEqual(skinStats(ps), { L: 55, a: 12, b: 18, pixels: 24 });
  ps.skinMask.fill(0);
  assert.equal(skinStats(ps), null);
});

test('non-mask pixels and alpha remain unchanged', () => {
  const data = new Uint8Array([180, 130, 100, 73, 180, 130, 100, 91]);
  const before = data.slice();
  applySkinMatchRGBA(data, { deltaL: 8, deltaA: 4, deltaB: 6 }, new Uint8Array([255, 0]));
  assert.notDeepEqual(data.slice(0, 3), before.slice(0, 3));
  assert.deepEqual(data.slice(3), before.slice(3));
});

test('midtone match preserves light-to-shadow ordering', () => {
  const match = { deltaL: 10, deltaA: 3, deltaB: 4 };
  const Ls = [25, 45, 65, 85];
  const out = Ls.map((L) => {
    const rgb = rgbFor(L, 10, 15), r = [...rgb, 0, 0, 0];
    applySkinMatchLinear(r, { skinMatch: match }, 255);
    return r[3];
  });
  assert.ok(out.every((x, i) => i === 0 || x > out[i - 1]));
  assert.ok(out[0] - Ls[0] < out[1] - Ls[1]);
  assert.ok(out[3] - Ls[3] < out[2] - Ls[2]);
});

test('out-of-gamut chroma is reduced without clipping RGB', () => {
  const rgb = rgbFor(55, 12, 18), r = [...rgb, 0, 0, 0];
  applySkinMatchLinear(r, { skinMatch: { deltaL: 0, deltaA: 10, deltaB: 12 } }, 255);
  assert.ok(r.slice(0, 3).every((x) => x >= 0 && x <= 1));
});

test('zero strength, identity, and invalid targets are no-ops', () => {
  const ps = makePs(), before = [55, 12, 18];
  assert.equal(fitSkinMatch(ps, ps, { L: 40, a: 0, b: 0 }, { move: 0 }).deltaL, 0);
  assert.equal(fitSkinMatch(ps, ps, null), null);
  ps.skinMask.fill(0);
  assert.equal(fitSkinMatch(ps, ps, { L: 40, a: 0, b: 0 }), null);
  const rgb = rgbFor(...before), r = [...rgb, 0, 0, 0], copy = r.slice();
  applySkinMatchLinear(r, { skinMatch: { deltaL: 0, deltaA: 0, deltaB: 0 } }, 255);
  assert.deepEqual(r, copy);
});

test('RGBA and linear paths agree within 8-bit quantization', () => {
  const source = [160, 115, 94, 255], mask = new Uint8Array([255]);
  const r = [SRGB8_TO_LIN[source[0]], SRGB8_TO_LIN[source[1]], SRGB8_TO_LIN[source[2]], 0, 0, 0];
  const match = { deltaL: -5, deltaA: 3, deltaB: 7 };
  applySkinMatchLinear(r, { skinMatch: match }, 255);
  const expected = r.slice(0, 3).map((v) => Math.round(linearToSrgb(v) * 255));
  const actual = Uint8Array.from(source);
  applySkinMatchRGBA(actual, match, mask);
  assert.ok(actual.slice(0, 3).every((v, i) => Math.abs(v - expected[i]) <= 1));
});
