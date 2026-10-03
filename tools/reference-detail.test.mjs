import test from 'node:test';
import assert from 'node:assert/strict';
import { linToLab, SRGB8_TO_LIN } from '../engine/color.js';
import { referenceDetailStats, fitReferenceDetail, applyReferenceDetailRGBA } from '../engine/reference-detail.js';

function planes(width, height, fn) {
  const n = width * height, lr = new Float64Array(n), lg = new Float64Array(n), lb = new Float64Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fn(x, y), i = y * width + x;
    lr[i] = r; lg[i] = g; lb[i] = b;
  }
  return { width, height, n, lr, lg, lb };
}
function checker(width = 32, height = 32) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, v = (x + y) % 2 ? 170 : 90, o = i * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 73;
  }
  const ps = planes(width, height, (x, y) => {
    const v = rgba[(y * width + x) * 4] / 255;
    const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return [linear, linear, linear];
  });
  return { ps, rgba };
}

test('measures robust local L detail and reports actual neighborhood support', () => {
  const { ps } = checker();
  const stats = referenceDetailStats(ps);
  assert.equal(stats.n, 900);
  assert.ok(stats.detail > 1);
  assert.equal(referenceDetailStats(ps, { mask: new Uint8Array(ps.n) }), null);
});

test('fit interpolates the measured detail ratio and zero strength is identity', () => {
  const source = { n: 300, detail: 4 }, target = { n: 400, detail: 10 };
  assert.deepEqual(fitReferenceDetail(source, target), { gain: 2.5 });
  assert.deepEqual(fitReferenceDetail(source, target, { strength: 0.5 }), { gain: 1.75 });
  assert.deepEqual(fitReferenceDetail(source, target, { strength: 0 }), { gain: 1 });
  assert.equal(fitReferenceDetail({ n: 300, detail: 0 }, target), null);
  assert.equal(fitReferenceDetail({ n: 199, detail: 1 }, target), null);
});

test('applying fitted gain changes checker contrast toward measured target', () => {
  const { ps, rgba } = checker();
  const source = referenceDetailStats(ps);
  const gain = 1.5;
  const out = applyReferenceDetailRGBA(rgba, ps.width, ps.height, { gain });
  const afterPlanes = planes(ps.width, ps.height, (x, y) => {
    const i = (y * ps.width + x) * 4;
    return [SRGB8_TO_LIN[out[i]], SRGB8_TO_LIN[out[i + 1]], SRGB8_TO_LIN[out[i + 2]]];
  });
  const after = referenceDetailStats(afterPlanes);
  assert.ok(after.detail > source.detail * 1.3 && after.detail < source.detail * 1.7,
    `contrast should move toward gain ${gain}: ${after.detail} / ${source.detail}`);
  assert.equal(out[3], 73);
});

test('constant image stays byte-identical and strength zero preserves bytes and alpha', () => {
  const rgba = new Uint8ClampedArray(24 * 24 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 123; rgba[i + 1] = 91; rgba[i + 2] = 207; rgba[i + 3] = i & 255; }
  assert.deepEqual(applyReferenceDetailRGBA(rgba, 24, 24, { gain: 4 }), rgba);
  assert.deepEqual(applyReferenceDetailRGBA(rgba, 24, 24, fitReferenceDetail({ n: 300, detail: 2 }, { n: 300, detail: 8 }, { strength: 0 })), rgba);
});

test('subject and background gains blend independently through the mask', () => {
  const rgba = new Uint8ClampedArray(12 * 12 * 4);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const v = (x + y) % 2 ? 170 : 90, i = (y * 12 + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  const mask = new Uint8Array(144);
  mask.fill(255, 0, 72);
  const out = applyReferenceDetailRGBA(rgba, 12, 12, { subject: { gain: 2 }, background: { gain: 1 } }, mask);
  assert.notDeepEqual(out.slice(0, 3), rgba.slice(0, 3));
  const backgroundPixel = (10 * 12 + 10) * 4;
  assert.deepEqual(out.slice(backgroundPixel, backgroundPixel + 4), rgba.slice(backgroundPixel, backgroundPixel + 4));
  assert.deepEqual(out.slice(3, 4), rgba.slice(3, 4));
});

test('full-frame detail equals two independently rendered halo bands across the seam', () => {
  const width = 17, height = 13, split = 6, ch = 4;
  const rgba = new Uint8ClampedArray(width * height * ch), mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, o = i * ch;
    rgba[o] = 38 + (x * 13 + y * 7) % 190;
    rgba[o + 1] = 42 + (x * 5 + y * 17) % 180;
    rgba[o + 2] = 35 + (x * 19 + y * 3) % 195;
    rgba[o + 3] = (x * 29 + y * 11) % 256;
    mask[i] = Math.round(255 * (0.5 + 0.5 * Math.sin(x * 0.41 + y * 0.27)));
  }
  const detail = { subject: { gain: 1.8 }, background: { gain: 0.65 } };
  const full = applyReferenceDetailRGBA(rgba, width, height, detail, mask, ch);
  const assembled = new Uint8ClampedArray(rgba.length);
  const crop = (start, end) => rgba.slice(start * width * ch, end * width * ch);
  const cropMask = (start, end) => mask.slice(start * width, end * width);
  const copyBand = (rendered, tileStart, sourceStart, sourceEnd) => {
    const from = (sourceStart - tileStart) * width * ch;
    const to = from + (sourceEnd - sourceStart) * width * ch;
    assembled.set(rendered.subarray(from, to), sourceStart * width * ch);
  };
  const upper = applyReferenceDetailRGBA(crop(0, split + 1), width, split + 1, detail, cropMask(0, split + 1), ch);
  const lower = applyReferenceDetailRGBA(crop(split - 1, height), width, height - split + 1, detail, cropMask(split - 1, height), ch);
  copyBand(upper, 0, 0, split);
  copyBand(lower, split - 1, split, height);
  assert.deepEqual(assembled, full, 'RGB and alpha bytes must match on both sides of the seam');
});

test('out-of-gamut luminance adjustment maps chroma at fixed L and hue, never clips channels', () => {
  const rgba = new Uint8ClampedArray(9 * 9 * 4);
  for (let i = 0; i < 81; i++) { rgba[i * 4] = 110; rgba[i * 4 + 1] = 115; rgba[i * 4 + 2] = 120; rgba[i * 4 + 3] = 255; }
  rgba[40 * 4] = 255; rgba[40 * 4 + 1] = 0; rgba[40 * 4 + 2] = 0;
  const out = applyReferenceDetailRGBA(rgba, 9, 9, { gain: 2.5 });
  const i = 40 * 4, actual = linToLab(SRGB8_TO_LIN[out[i]], SRGB8_TO_LIN[out[i + 1]], SRGB8_TO_LIN[out[i + 2]], [0, 0, 0]);
  const before = linToLab(SRGB8_TO_LIN[255], 0, 0, [0, 0, 0]);
  assert.ok(out.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
  assert.ok(actual[0] > before[0]);
  assert.ok(actual[1] > 0 && Math.abs(actual[2] / actual[1] - before[2] / before[1]) < 0.03,
    `mapped hue [${actual[1]}, ${actual[2]}]`);
});
