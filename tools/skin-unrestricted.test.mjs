import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkinMatchLinear, fitSkinMatch, skinStats } from '../engine/skin-match.js';
import { labToLin } from '../engine/color.js';

const rgb = (L, a = 8, b = 12) => labToLin(L, a, b, [0, 0, 0]);
const result = (L, match, mask = 255, id = 0) => {
  const c = rgb(L), out = [...c, 0, 0, 0];
  applySkinMatchLinear(out, { skinMatch: match }, mask, id, L);
  return out;
};

test('fit allows strong lightness shifts beyond twelve Lab units', () => {
  const n = 30, ps = { L: new Float32Array(n).fill(50), A: new Float32Array(n).fill(8), B: new Float32Array(n).fill(12), skinMask: new Uint8Array(n).fill(255) };
  const match = fitSkinMatch(ps, ps, { L: 80, a: 8, b: 12, pixels: n });
  assert.ok(match.deltaL > 25);
  assert.ok(Math.abs(result(50, match)[3] - 80) < 0.1);
});

test('shadows and highlights receive full corrections', () => {
  const match = { deltaL: 8, deltaA: 2, deltaB: 3 };
  for (const L of [5, 15, 25, 90]) assert.ok(result(L, match)[3] > L + 7.8, `L=${L}`);
  assert.ok(result(98, match)[3] > 99.5, 'near-white highlight reaches the physical L=100 boundary');
});

test('partial strength is anchored to original skin stats when current image is already edited', () => {
  const n = 30, ps = { L: new Float32Array(n).fill(50), A: new Float32Array(n).fill(8), B: new Float32Array(n).fill(12), skinMask: new Uint8Array(n).fill(255) };
  const cur = { L: new Float32Array(n).fill(60), A: ps.A.slice(), B: ps.B.slice() };
  const target = { L: 70, a: 8, b: 12, pixels: n };
  assert.equal(skinStats(ps, cur).L, 60);
  const match = fitSkinMatch(ps, cur, target, { move: 0.5 });
  assert.ok(Math.abs(match.deltaL) < 0.001, 'current +10 already equals halfway target from original');
});

test('per person corrections remain independent and masks remain correctable', () => {
  const n = 120, ps = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), skinMask: new Uint8Array(n).fill(255), skinPeople: new Uint8Array(n), skinPositions: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 1, y: 0 }] };
  for (let i = 0; i < n; i++) {
    const person = i < 60 ? 1 : 2, zone = Math.floor((i % 60) / 20);
    ps.skinPeople[i] = person; ps.L[i] = [25, 52, 78][zone]; ps.A[i] = person === 1 ? 8 : 24; ps.B[i] = 12;
  }
  const target = skinStats(ps);
  for (const person of target.people) for (const zone of Object.values(person.zones)) zone.L += person.id === 1 ? 16 : -11;
  const match = fitSkinMatch(ps, ps, target);
  const one = result(52, match, 255, 1), two = result(52, match, 255, 2), masked = result(52, match, 0, 1);
  assert.ok(one[3] > 65);
  assert.ok(two[3] < 45);
  assert.deepEqual(masked.slice(0, 3), rgb(52));
});
