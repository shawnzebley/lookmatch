import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePreset } from '../engine/lrpreset.js';
import { dynamicPreset, masterCurve, parametricOffset } from '../engine/dynamic-preset.js';
import { compile, curveLUT } from '../engine/pipeline.js';

const pack = JSON.parse(fs.readFileSync('web/looks/rupp.json', 'utf8'));
const load = (look) => parsePreset(fs.readFileSync(`web/${look.xmp}`, 'utf8')).settings;

test('six dynamic looks, each with a readable recipe', () => {
  assert.equal(pack.looks.length, 6);
  assert.equal(new Set(pack.looks.map((l) => l.id)).size, 6);
  for (const look of pack.looks) {
    const s = load(look);
    const { params, steps, notApplied } = dynamicPreset(look, s);
    // global sliders are the published values, untouched
    assert.equal(params.exposure, s.Exposure2012, look.id);
    assert.equal(params.contrast, s.Contrast2012, look.id);
    assert.equal(params.vibrance, s.Vibrance, look.id);
    assert.equal(params.sat_blue, s.SaturationAdjustmentBlue, look.id);
    assert.deepEqual(params.curveR, s.ToneCurvePV2012Red.every(([x, y]) => x === y) ? undefined : s.ToneCurvePV2012Red, look.id);
    assert.equal(steps[0].step, 'Light');
    assert.equal(steps.length, 7 + look.masks.length);
    assert.ok(!notApplied.includes('parametric curve'), 'parametric is folded into the master curve');
    if (s.WhiteBalance === 'Custom') assert.ok(notApplied.includes('Kelvin white balance'));
    // the whole recipe renders to finite colors
    const f = compile(params), out = new Float32Array(6);
    for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) {
      f(v, v * 0.8, v * 0.6, out);
      for (let i = 0; i < 3; i++) assert.ok(Number.isFinite(out[i]), `${look.id} ${v}`);
    }
    // master curve never runs backwards
    if (params.curve) { const lut = curveLUT(params.curve); for (let i = 1; i < lut.length; i++) assert.ok(lut[i] >= lut[i - 1] - 1e-6, look.id); }
  }
});

test('parametric curve: end points held, sign follows the slider', () => {
  const s = { ParametricDarks: -10, ParametricLights: 8 };
  assert.equal(parametricOffset(0, s), 0);
  assert.equal(parametricOffset(255, s), 0);
  assert.ok(parametricOffset(96, s) < 0);
  assert.ok(parametricOffset(160, s) > 0);
  assert.ok(Math.abs(parametricOffset(96, { ParametricDarks: -100 }) + 30) < 2, 'about 30 levels at -100');
});

test('identity curve with no parametric stays identity', () => {
  for (const [x, y] of masterCurve({ ToneCurvePV2012: [[0, 0], [255, 255]] })) assert.ok(Math.abs(x - y) < 0.2);
});

test('Rupp 02 carries its whole-image fade', () => {
  const look = pack.looks.find((l) => l.id === 'rupp-02-vintage-film-window');
  const { params } = dynamicPreset(look, load(look));
  assert.ok(Math.abs(params.curve[0][1] - 25) < 1, 'blacks lifted to 25');
  assert.ok(params.curve.at(-1)[1] <= 245.5, 'whites lowered to 245');
});
