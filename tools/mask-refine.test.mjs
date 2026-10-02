import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseCropProbabilities, personProbabilities } from '../engine/mask-refine.js';

test('accessories stay with nearby person classes and skin includes only skin channels', () => {
  const channels = () => new Float32Array(24);
  const hair = channels(), body = channels(), face = channels(), clothes = channels(), accessories = channels();
  const supported = 1 * 6 + 1, attachedAccessory = 1 * 6 + 2;
  hair[supported] = 0.2; body[supported] = 0.3; face[supported] = 0.1; clothes[supported] = 0.2;
  accessories[attachedAccessory] = 0.8;
  for (let y = 1; y <= 2; y++) for (let x = 4; x <= 5; x++) accessories[y * 6 + x] = 0.9; // detached box
  const { foreground, skin } = personProbabilities({ hair, body, face, clothes, accessories, width: 6, height: 4 });
  assert.ok(Math.abs(foreground[supported] - 0.8) < 1e-6);
  assert.ok(Math.abs(foreground[attachedAccessory] - 0.8) < 1e-6, 'attached accessory remains part of the person');
  assert.equal(foreground[1 * 6 + 5], 0, 'unsupported accessory box is excluded');
  assert.ok(Math.abs(skin[supported] - 0.4) < 1e-6);
});

test('crop fusion rejects box-shaped foreground beyond full-frame support while allowing a nearby extension', () => {
  const width = 24, height = 16;
  const base = new Float32Array(width * height);
  for (let y = 5; y <= 10; y++) for (let x = 5; x <= 8; x++) base[y * width + x] = 0.9;
  const cropWidth = 17, cropHeight = 13;
  const crop = new Float32Array(cropWidth * cropHeight).fill(0.95); // deliberately square false-positive crop
  fuseCropProbabilities(base, crop, width, height, {
    x0: 2, y0: 2, cropWidth, cropHeight, fade: 2, supportRadius: 2,
  });
  assert.ok(base[7 * width + 10] > 0.9, 'crop may extend the supported person boundary nearby');
  assert.equal(base[7 * width + 11], 0, 'crop cannot paint a detached square region');
  assert.equal(base[2 * width + 10], 0, 'unsupported background remains background');
});
