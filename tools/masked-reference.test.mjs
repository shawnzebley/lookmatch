import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, measure } from '../engine/measure.js';
import { processPixelSet, regionParams } from '../engine/pipeline.js';
import { referenceRegionTargets, solveMaskedReference } from '../engine/masked-reference.js';

const WIDTH = 40;
const HEIGHT = 20;
const N = WIDTH * HEIGHT;
const HALF = WIDTH / 2;
const SUBJECT_IDX = Int32Array.from({ length: N / 2 }, (_, k) => Math.floor(k / HEIGHT) * WIDTH + k % HEIGHT);
const BACKGROUND_IDX = Int32Array.from({ length: N / 2 }, (_, k) => Math.floor(k / HEIGHT) * WIDTH + HALF + k % HEIGHT);
const SUBJECT_MASK = Uint8Array.from({ length: N }, (_, i) => i % WIDTH < HALF ? 255 : 0);

function fixture(subjectRgb, backgroundRgb) {
  const data = new Uint8Array(N * 3);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = y * WIDTH + x, rgb = x < HALF ? subjectRgb : backgroundRgb;
    // A real brightness range gives tone and curve fitting useful support within each region.
    const gain = 0.72 + 0.28 * y / (HEIGHT - 1);
    for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.max(0, Math.min(255, Math.round(rgb[c] * gain)));
  }
  return prepare({ width: WIDTH, height: HEIGHT, data, channels: 3 }, { subject: SUBJECT_MASK });
}

function meanAB(ps, cur, indices) {
  let a = 0, b = 0;
  for (const i of indices) { a += cur.A[i]; b += cur.B[i]; }
  return [a / indices.length, b / indices.length];
}

const warm = [185, 125, 75];
const cool = [75, 125, 185];
const opts = { colorIters: 4 };

test('fits subject and background independently to opposing reference colors', () => {
  const source = fixture(cool, warm);
  const reference = fixture(warm, cool);
  const maskedRegions = referenceRegionTargets(reference);
  assert.ok(maskedRegions);
  const result = solveMaskedReference(source, { ...measure(reference), maskedRegions }, opts);
  assert.ok(result);
  assert.notDeepEqual(result.params.local.subject, result.params.local.background);
  assert.equal(result.params.local.subject.curveAuto, 'reference');
  assert.equal(result.params.local.background.curveAuto, 'reference');
  assert.equal(result.params.saturation, 0);
  assert.equal(result.params.temp, 0);
  assert.equal(result.regions.referenceStyle.regionCurves, true);

  const regions = regionParams(result.params);
  const subjectAfter = processPixelSet(source, regions.subject);
  const backgroundAfter = processPixelSet(source, regions.background);
  const subjectTarget = meanAB(reference, reference, SUBJECT_IDX);
  const backgroundTarget = meanAB(reference, reference, BACKGROUND_IDX);
  const distance = (ps, cur, indices, target) => {
    const [a, b] = meanAB(ps, cur, indices);
    return Math.hypot(a - target[0], b - target[1]);
  };
  const subjectBeforeError = distance(source, source, SUBJECT_IDX, subjectTarget);
  const backgroundBeforeError = distance(source, source, BACKGROUND_IDX, backgroundTarget);
  const subjectAfterError = distance(source, subjectAfter, SUBJECT_IDX, subjectTarget);
  const backgroundAfterError = distance(source, backgroundAfter, BACKGROUND_IDX, backgroundTarget);
  assert.ok(subjectAfterError < subjectBeforeError, `subject color error ${subjectBeforeError} -> ${subjectAfterError}`);
  assert.ok(backgroundAfterError < backgroundBeforeError, `background color error ${backgroundBeforeError} -> ${backgroundAfterError}`);
});

test('changing only the background target leaves subject parameters unchanged', () => {
  const source = fixture(cool, warm);
  const reference = fixture(warm, cool);
  const refStats = { ...measure(reference), maskedRegions: referenceRegionTargets(reference) };
  const original = solveMaskedReference(source, refStats, opts);
  const changed = structuredClone(refStats);
  changed.maskedRegions.background.wb.a += 18;
  changed.maskedRegions.background.wb.b -= 12;
  changed.maskedRegions.background.bands.red.hue += 25;
  const updated = solveMaskedReference(source, changed, opts);
  assert.deepEqual(updated.params.local.subject, original.params.local.subject);
});

test('returns null when subject mask support is missing or too small', () => {
  const source = fixture(cool, warm);
  const ref = fixture(warm, cool);
  assert.equal(referenceRegionTargets({ ...ref, subject: null }), null);
  assert.equal(referenceRegionTargets({ ...ref, subject: new Uint8Array(ref.n).fill(255) }), null);
  assert.equal(solveMaskedReference(source, { ...measure(ref), maskedRegions: null }, opts), null);
});
