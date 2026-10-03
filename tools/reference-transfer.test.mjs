import test from 'node:test';
import assert from 'node:assert/strict';
import { linToLab, labToLin } from '../engine/color.js';
import { referenceTransferStats, fitReferenceTransfer, applyReferenceTransferLinear } from '../engine/reference-transfer.js';

const lab = (r, g, b) => linToLab(r, g, b, [0, 0, 0]);
const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
function ps(colors) {
  return { n: colors.length, lr: Float64Array.from(colors, (c) => c[0]),
    lg: Float64Array.from(colors, (c) => c[1]), lb: Float64Array.from(colors, (c) => c[2]) };
}
function stats(Lquantiles, mean = [0, 0], std = [1, 1]) {
  return { version: 1, n: 10, Lquantiles, mean, std };
}

test('strength zero preserves representative RGB and Lab values', () => {
  const src = referenceTransferStats(ps([[0.2, 0.3, 0.4], [0.8, 0.5, 0.2]]));
  const tr = fitReferenceTransfer(src, src, { strength: 0 });
  const actual = applyReferenceTransferLinear(0.35, 0.22, 0.61, tr);
  const expected = lab(0.35, 0.22, 0.61);
  close(actual[0], 0.35); close(actual[1], 0.22); close(actual[2], 0.61);
  close(actual[3], expected[0]); close(actual[4], expected[1]); close(actual[5], expected[2]);
});

test('stats use mask threshold and return 257 interpolated L quantiles', () => {
  const s = referenceTransferStats(ps([[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5]]), { mask: Uint8Array.of(190, 191, 255) });
  assert.equal(s.n, 2); assert.equal(s.Lquantiles.length, 257);
  close(s.Lquantiles[0], lab(0.5, 0.5, 0.5)[0]); close(s.Lquantiles[256], 100);
});

test('full strength maps every source L quantile to the reference quantile', () => {
  const a = Array.from({ length: 257 }, (_, i) => i / 4);
  const b = Array.from({ length: 257 }, (_, i) => i / 2);
  const tr = fitReferenceTransfer(stats(a), stats(b));
  assert.deepEqual(tr.targetL, b);
});

test('a and b means and standard deviations match independently', () => {
  const source = stats(Array(257).fill(50), [2, -4], [2, 4]);
  const target = stats(Array(257).fill(50), [10, 6], [6, 2]);
  const tr = fitReferenceTransfer(source, target);
  const applyLab = (a, b) => [tr.targetMean[0] + (a - tr.sourceMean[0]) * tr.abScale[0], tr.targetMean[1] + (b - tr.sourceMean[1]) * tr.abScale[1]];
  assert.deepEqual(applyLab(2, -4), [10, 6]);
  assert.deepEqual(tr.abScale, [3, 0.5]);
});

test('flat and tied histograms stay finite and monotone', () => {
  const flat = stats(Array(257).fill(42), [3, 7], [0, 0]);
  const target = stats(Array.from({ length: 257 }, (_, i) => i * 100 / 256), [-2, 1], [5, 8]);
  const tr = fitReferenceTransfer(flat, target);
  assert.ok(tr.targetL.every(Number.isFinite));
  assert.ok(tr.targetL.every((v, i, arr) => i === 0 || v >= arr[i - 1]));
  assert.ok(tr.abScale.every(Number.isFinite));
  const out = applyReferenceTransferLinear(0.4, 0.4, 0.4, tr);
  assert.ok(out.every(Number.isFinite));
});

test('out of gamut colors preserve L and hue by reducing chroma, without channel clipping', () => {
  const flat = stats(Array(257).fill(60), [0, 0], [1, 1]);
  const extreme = stats(Array(257).fill(60), [140, 100], [1, 1]);
  const tr = fitReferenceTransfer(flat, extreme);
  const out = applyReferenceTransferLinear(0.45, 0.45, 0.45, tr);
  const originalL = lab(0.45, 0.45, 0.45)[0];
  assert.ok(out.slice(0, 3).every((v) => v >= 0 && v <= 1));
  const actual = lab(...out.slice(0, 3));
  close(actual[0], originalL, 0.02);
  const cross = actual[1] * 100 - actual[2] * 140;
  assert.ok(Math.abs(cross) < 0.15, `hue changed: ${cross}`);
  const requestedChroma = Math.hypot(100, 140), actualChroma = Math.hypot(actual[1], actual[2]);
  assert.ok(actualChroma < requestedChroma);
});

test('supported corresponding hue sector moves toward its reference sector', () => {
  const srcRgb = labToLin(60, 24, 0, [0, 0, 0]);
  const refRgb = labToLin(60, 20, 8, [0, 0, 0]);
  const source = referenceTransferStats(ps(Array.from({ length: 40 }, () => srcRgb)));
  const reference = referenceTransferStats(ps(Array.from({ length: 40 }, () => refRgb)));
  const tr = fitReferenceTransfer(source, reference);
  assert.ok(source.hueSectors.length > 0 && reference.hueSectors.length > 0);
  const before = lab(...srcRgb), after = applyReferenceTransferLinear(...srcRgb, tr);
  assert.ok(Math.hypot(after[4] - 20, after[5] - 8) < Math.hypot(before[1] - 20, before[2] - 8));
});

test('partial hue residual compares partially transformed global and sector means', () => {
  const source = { ...stats(Array(257).fill(55), [10, 5], [4, 4]),
    hueSectors: [{ center: 0, n: 100, mean: [20, 10] }] };
  const reference = { ...stats(Array(257).fill(55), [-8, 3], [4, 4]),
    hueSectors: [{ center: 0, n: 100, mean: [-4, 17] }] };
  const tr = fitReferenceTransfer(source, reference, { strength: 0.5 });
  // predicted=[11,9], desired=[8,13.5]
  close(tr.hueSectors[0].deltaA, -3); close(tr.hueSectors[0].deltaB, 4.5);
});

test('neutral pixels do not receive hue-sector residuals', () => {
  const neutral = labToLin(55, 0, 0, [0, 0, 0]);
  const source = stats(Array(257).fill(55), [0, 0], [10, 10]);
  const target = { ...stats(Array(257).fill(55), [0, 0], [10, 10]),
    hueSectors: Array.from({ length: 12 }, (_, i) => ({ center: i * 30, n: 50, mean: [30, -25] })) };
  const out = applyReferenceTransferLinear(...neutral, fitReferenceTransfer(source, target));
  close(out[4], 0, 0.02); close(out[5], 0, 0.02);
});

test('unsupported dominant reference hue does not recolor an unrelated source hue', () => {
  const source = { ...stats(Array(257).fill(55), [0, 0], [10, 10]),
    hueSectors: [{ center: 0, n: 100, mean: [25, 0] }] };
  const reference = { ...stats(Array(257).fill(55), [0, 0], [10, 10]),
    hueSectors: [{ center: 0, n: 100, mean: [0, 25] }, { center: 180, n: 100, mean: [-25, 0] }] };
  const tr = fitReferenceTransfer(source, reference);
  const blueGreen = labToLin(55, -15, -10, [0, 0, 0]);
  const out = applyReferenceTransferLinear(...blueGreen, tr);
  const expected = lab(...blueGreen);
  close(out[4], expected[1]); close(out[5], expected[2]);
});

test('a single supported hue sector fades continuously at its membership edge', () => {
  const source = { ...stats(Array(257).fill(60), [0, 0], [1, 1]),
    hueSectors: [{ center: 0, n: 100, mean: [18, 0] }] };
  const reference = { ...stats(Array(257).fill(60), [0, 0], [1, 1]),
    hueSectors: [{ center: 0, n: 100, mean: [0, 18] }] };
  const transform = fitReferenceTransfer(source, reference);
  const at = (degrees) => {
    const radians = degrees * Math.PI / 180;
    const rgb = labToLin(60, 30 * Math.cos(radians), 30 * Math.sin(radians), [0, 0, 0]);
    const actual = applyReferenceTransferLinear(...rgb, transform);
    return [actual[4], actual[5]];
  };
  const epsilon = 1e-5;
  const beforeEdge = at(60 - epsilon), afterEdge = at(60 + epsilon);
  assert.ok(Math.hypot(beforeEdge[0] - afterEdge[0], beforeEdge[1] - afterEdge[1]) < 1e-3,
    `jump at sector boundary: ${beforeEdge} vs ${afterEdge}`);
});

test('reused six-value output buffers gamut-map only RGB and report actual Lab', () => {
  const source = stats(Array(257).fill(60), [0, 0], [1, 1]);
  const target = stats(Array(257).fill(60), [140, 100], [1, 1]);
  const out = new Float64Array([0, 0, 0, 999, 999, 999]);
  applyReferenceTransferLinear(0.45, 0.45, 0.45, fitReferenceTransfer(source, target), out);
  assert.ok(out.slice(0, 3).every((v) => v >= 0 && v <= 1));
  const actual = lab(...out.slice(0, 3));
  close(out[3], actual[0], 1e-6); close(out[4], actual[1], 1e-6); close(out[5], actual[2], 1e-6);
});

test('flat source L quantiles map to target median without flattening outlying highlights', () => {
  const source = stats(Array(257).fill(40));
  const target = stats(Array.from({ length: 257 }, (_, i) => i * 100 / 256));
  const tr = fitReferenceTransfer(source, target);
  const flatPixel = applyReferenceTransferLinear(...labToLin(40, 0, 0, [0, 0, 0]), tr);
  const brightPixel = applyReferenceTransferLinear(...labToLin(90, 0, 0, [0, 0, 0]), tr);
  close(flatPixel[3], 50, 0.1); close(brightPixel[3], 100, 0.1);
});

test('source L plateau maps continuously around tied quantiles', () => {
  const sourceL = Array.from({ length: 257 }, (_, i) => i < 80 ? i * 0.5 : i < 180 ? 40 : 40 + (i - 179) * 0.5);
  const targetL = Array.from({ length: 257 }, (_, i) => 10 + i * 0.3);
  const tr = fitReferenceTransfer(stats(sourceL), stats(targetL));
  const at = (L) => applyReferenceTransferLinear(...labToLin(L, 0, 0, [0, 0, 0]), tr)[3];
  const lo = at(40 - 1e-6), mid = at(40), hi = at(40 + 1e-6);
  assert.ok(Math.abs(lo - mid) < 1e-4, `${lo} vs ${mid}`);
  assert.ok(Math.abs(hi - mid) < 1e-4, `${hi} vs ${mid}`);
});
