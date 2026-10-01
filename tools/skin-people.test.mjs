import test from 'node:test';
import assert from 'node:assert/strict';
import { assignPeople } from '../engine/skin-people.js';

test('pose labels keep confident winners and leave background and ambiguous pixels unlabeled', () => {
  const result = assignPeople({
    width: 4, height: 1,
    poseMasks: [Uint8Array.of(204, 153, 102, 26), Uint8Array.of(26, 128, 51, 191)],
    positions: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
  });
  assert.deepEqual([...result.labels], [1, 0, 0, 2]);
  assert.equal(result.ambiguous, 1);
  assert.deepEqual(result.positions.map(({ id, scope }) => [id, scope]), [[1, 'person'], [2, 'person']]);
});

test('face-only fallback stays inside facial polygons and does not label clothing or body pixels', () => {
  const width = 10, height = 10;
  const face = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
  const skin = new Uint8Array(width * height).fill(255);
  const result = assignPeople({ width, height, faces: [face], skin });
  assert.ok(result.labels[5 * width + 5] > 0);
  assert.equal(result.labels[1 * width + 5], 0);
  assert.equal(result.labels[8 * width + 5], 0);
  assert.equal(result.positions[0].scope, 'face');
});

test('pose and face assignment matches nearby faces once and adds an id for unmatched faces', () => {
  const width = 20, height = 10;
  const poseMasks = [new Float32Array(width * height), new Float32Array(width * height)];
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) poseMasks[0][y * width + x] = 0.9;
  for (let y = 2; y < 8; y++) for (let x = 12; x < 18; x++) poseMasks[1][y * width + x] = 0.9;
  const faceNearPose = [[0.2, 0.1], [0.4, 0.1], [0.4, 0.3], [0.2, 0.3]];
  const faceWithoutPose = [[0.75, 0.6], [0.9, 0.6], [0.9, 0.85], [0.75, 0.85]];
  const result = assignPeople({
    width, height, poseMasks,
    positions: [{ x: 0.3, y: 0.2 }, { x: 0.75, y: 0.2 }],
    faces: [faceNearPose, faceWithoutPose],
    skin: new Uint8Array(width * height).fill(255),
  });
  assert.deepEqual(result.positions.map(({ id, scope }) => [id, scope]), [[1, 'person'], [2, 'person'], [3, 'face']]);
  assert.equal(result.labels[4 * width + 4], 1);
  assert.equal(result.labels[5 * width + 15], 2, 'matched face stays attached to its pose id');
  assert.equal(result.labels[7 * width + 16], 3, 'unmatched face receives its own local id');
});
