import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkinMatchLinear, applySkinMatchRGBA, fitSkinMatch, skinStats } from '../engine/skin-match.js';
import { SRGB8_TO_LIN, linearToSrgb, linToLab, labToLin } from '../engine/color.js';

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
  for (let i = 0; i < Ls.length; i++) assert.ok(Math.abs(out[i] - Ls[i] - 10) < 0.01);
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

function makeGroupedPs({ people = [1, 2], perZone = 24, centers = [25, 52, 78] } = {}) {
  const n = people.length * perZone * centers.length;
  const ps = { n, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), skinMask: new Uint8Array(n).fill(255), skinPeople: new Uint8Array(n), skinPositions: [] };
  let i = 0;
  for (let pi = 0; pi < people.length; pi++) {
    const id = people[pi]; ps.skinPositions.push({ id, x: pi / Math.max(1, people.length - 1), y: 0.5 });
    for (let z = 0; z < centers.length; z++) for (let k = 0; k < perZone; k++, i++) {
      ps.skinPeople[i] = id; ps.L[i] = centers[z] + (k % 3) * 0.1;
      ps.A[i] = 8 + pi * 12 + z; ps.B[i] = 10 + pi * 10 + z * 2;
    }
  }
  return ps;
}

function shiftedReference(ps, { aShift = 3, bShift = 5, lShift = -3 } = {}) {
  const ref = skinStats(ps);
  for (const person of ref.people) for (const zone of Object.values(person.zones)) {
    zone.L += lShift; zone.a += aShift; zone.b += bShift;
  }
  return ref;
}

test('grouped stats expose people and fixed original tone zones', () => {
  const ps = makeGroupedPs({ people: [1], perZone: 24 });
  const before = skinStats(ps);
  const cur = { L: ps.L.slice(), A: ps.A.slice(), B: ps.B.slice() };
  cur.L.fill(60); cur.A.fill(40);
  const after = skinStats(ps, cur);
  assert.equal(before.version, 2);
  assert.equal(before.people[0].pixels, 72);
  assert.deepEqual(Object.keys(after.people[0].zones).sort(), ['lit', 'midtone', 'shadow']);
  assert.equal(after.people[0].zones.shadow.pixels, 24);
  assert.notEqual(after.people[0].zones.shadow.center, after.people[0].zones.lit.center);
});

test('constant skin collapses duplicate quantile splits into midtone', () => {
  const ps = makeGroupedPs({ people: [1], perZone: 30, centers: [50] });
  ps.L.fill(50);
  const stats = skinStats(ps);
  assert.deepEqual(Object.keys(stats.people[0].zones), ['midtone']);
});

test('v2 match keeps each person color correction isolated', () => {
  const ps = makeGroupedPs({ people: [1, 2] });
  const target = shiftedReference(ps, { aShift: 5, bShift: 3, lShift: -2 });
  for (const person of target.people) {
    const amount = person.id === 1 ? 2 : -5;
    for (const zone of Object.values(person.zones)) zone.a += amount;
  }
  const match = fitSkinMatch(ps, ps, target);
  assert.equal(match.version, 2);
  const getA = (id, L, a, b) => {
    const rgb = rgbFor(L, a, b), res = [...rgb, 0, 0, 0];
    applySkinMatchLinear(res, { skinMatch: match }, 255, id, L);
    return res[4];
  };
  const a1 = getA(1, 52, 20, 20), a2 = getA(2, 52, 32, 30);
  assert.ok(a1 > 20);
  assert.ok(a2 < 32);
  const original = rgbFor(52, 20, 20), unknown = [...original, 0, 0, 0];
  applySkinMatchLinear(unknown, { skinMatch: match }, 255, 99, 52);
  assert.deepEqual(unknown.slice(0, 3), original);
});

test('shadow, midtone, and lit corrections fit their own reference colors', () => {
  const ps = makeGroupedPs({ people: [1] }), target = shiftedReference(ps, { aShift: 0, bShift: 0, lShift: 0 });
  const shifts = { shadow: { L: -7, a: -2, b: 1 }, midtone: { L: 1, a: 4, b: 2 }, lit: { L: 7, a: 1, b: 8 } };
  for (const zone of Object.keys(shifts)) for (const key of ['L', 'a', 'b']) target.people[0].zones[zone][key] += shifts[zone][key];
  const match = fitSkinMatch(ps, ps, target);
  const zones = match.people[0].zones;
  assert.notEqual(zones.find((z) => z.name === 'shadow').deltaL, zones.find((z) => z.name === 'lit').deltaL);
  assert.notEqual(zones.find((z) => z.name === 'midtone').deltaA, zones.find((z) => z.name === 'shadow').deltaA);
  assert.notEqual(zones.find((z) => z.name === 'lit').deltaB, zones.find((z) => z.name === 'midtone').deltaB);
});

test('supplied but unassigned labels keep stats version 2 with no supported people', () => {
  const ps = makePs(); ps.skinPeople = new Uint8Array(ps.n);
  const stats = skinStats(ps);
  assert.equal(stats.version, 2);
  assert.deepEqual(stats.people, []);
  assert.equal(fitSkinMatch(ps, ps, { ...stats, L: 40, a: 0, b: 0 }), null);
  assert.deepEqual(fitSkinMatch(makeGroupedPs({ people: [1] }), makeGroupedPs({ people: [1] }), { ...stats, people: [] }), { version: 2, people: [], targets: [] });
});

test('missing skin mask yields no stats or fit', () => {
  const ps = makePs(); ps.skinPeople = new Uint8Array(ps.n); delete ps.skinMask;
  assert.equal(skinStats(ps), null);
  assert.equal(fitSkinMatch(ps, ps, { version: 2, people: [] }), null);
});

test('varied real RGB tones improve against each reference zone after actual rendering', () => {
  const ps = makeGroupedPs({ people: [1], perZone: 40 });
  // Spread source tones across all three fixed original-L zones.
  for (let i = 0; i < ps.n; i++) {
    const step = i / (ps.n - 1);
    ps.L[i] = 20 + 70 * step;
    ps.A[i] = 8 + 3 * step;
    ps.B[i] = 10 + 4 * step;
  }
  const target = skinStats(ps);
  const offsets = { shadow: [-3, 2, 3], midtone: [2, -3, 4], lit: [-2, 3, -3] };
  for (const [name, d] of Object.entries(offsets)) {
    target.people[0].zones[name].L += d[0];
    target.people[0].zones[name].a += d[1];
    target.people[0].zones[name].b += d[2];
  }
  const match = fitSkinMatch(ps, ps, target);
  const got = { L: new Float32Array(ps.n), A: new Float32Array(ps.n), B: new Float32Array(ps.n) };
  for (let i = 0; i < ps.n; i++) {
    const rgb = labToLin(ps.L[i], ps.A[i], ps.B[i], [0, 0, 0]);
    const res = [...rgb, 0, 0, 0];
    applySkinMatchLinear(res, { skinMatch: match }, ps.skinMask[i], ps.skinPeople[i], ps.L[i]);
    got.L[i] = res[3]; got.A[i] = res[4]; got.B[i] = res[5];
  }
  const after = skinStats(ps, got).people[0].zones;
  for (const name of ['shadow', 'midtone', 'lit']) {
    const targetZone = target.people[0].zones[name], beforeZone = match.people[0].zones.find((z) => z.name === name).before;
    assert.ok(error(after[name], targetZone) < error(beforeZone, targetZone), `${name} did not improve`);
    assert.ok(after[name]);
  }
});

test('multiple reference people pair one-to-one by global nearest positions', () => {
  const ps = makeGroupedPs({ people: [1, 2], perZone: 24 });
  ps.skinPositions = [{ id: 1, x: 0.2, y: 0 }, { id: 2, x: 0.8, y: 0 }];
  const target = shiftedReference(ps);
  target.people[0].id = 10; target.people[0].position = { x: 0, y: 0 };
  target.people[1].id = 11; target.people[1].position = { x: 0.3, y: 0 };
  const match = fitSkinMatch(ps, ps, target);
  assert.deepEqual(match.people.map((p) => [p.id, p.referenceId]), [[1, 10], [2, 11]]);
  assert.equal(new Set(match.people.map((p) => p.referenceId)).size, 2);
});

test('single reference person styles all source people; unsupported v2 reference skips', () => {
  const ps = makeGroupedPs({ people: [1, 2] }), target = shiftedReference(makeGroupedPs({ people: [9] }));
  const match = fitSkinMatch(ps, ps, target);
  assert.equal(match.people.length, 2);
  const noPeople = makePs(); noPeople.skinPeople = new Uint8Array(noPeople.n);
  assert.equal(fitSkinMatch(noPeople, noPeople, target), null);
});

test('sparse zones are omitted; legacy reference still produces aggregate params', () => {
  const ps = makeGroupedPs({ people: [1], perZone: 24 });
  ps.skinMask.fill(0, 0, 24); // no confident shadow samples remain
  const stats = skinStats(ps);
  assert.equal(stats.people[0].zones.shadow, undefined);
  const legacy = fitSkinMatch(ps, ps, { L: 50, a: 12, b: 16, pixels: 100 });
  assert.equal(typeof legacy.deltaA, 'number');
});

test('v2 RGBA uses original pixels for zone selection and preserves alpha', () => {
  const ps = makeGroupedPs({ people: [1] }), match = fitSkinMatch(ps, ps, shiftedReference(ps));
  const before = new Uint8Array([120, 80, 60, 77, 210, 170, 150, 88]);
  const data = before.slice(), mask = new Uint8Array([255, 255]), people = new Uint8Array([1, 1]);
  applySkinMatchRGBA(data, match, mask, 4, people, before);
  assert.notDeepEqual(data.slice(0, 3), before.slice(0, 3));
  assert.notDeepEqual(data.slice(4, 7), before.slice(4, 7));
  assert.equal(data[3], before[3]); assert.equal(data[7], before[7]);
});

test('RGBA leaves zero-mask and unassigned v2 pixels byte-identical', () => {
  const ps = makeGroupedPs({ people: [1] }), match = fitSkinMatch(ps, ps, shiftedReference(ps));
  const before = new Uint8Array([123, 91, 72, 41, 123, 91, 72, 42]);
  const data = before.slice();
  applySkinMatchRGBA(data, match, new Uint8Array([0, 255]), 4, new Uint8Array([1, 0]), before);
  assert.deepEqual(data, before);
});

test('RGBA batch matches the single-pixel linear path across people and masks', () => {
  const ps = makeGroupedPs({ people: [1, 2] }), match = fitSkinMatch(ps, ps, shiftedReference(ps));
  const n = 36, ch = 4, original = new Uint8Array(n * ch), actual = new Uint8Array(n * ch);
  const mask = new Uint8Array(n), people = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * ch, r = 50 + (i * 29) % 190;
    original[j] = actual[j] = r; original[j + 1] = actual[j + 1] = 40 + (i * 43) % 200;
    original[j + 2] = actual[j + 2] = 30 + (i * 61) % 210; original[j + 3] = actual[j + 3] = 90 + i;
    mask[i] = i % 5 === 0 ? 0 : i % 3 === 0 ? 192 : 255;
    people[i] = i % 7 === 0 ? 0 : 1 + (i % 2);
  }
  const expected = actual.slice(), res = [0, 0, 0, 0, 0, 0], lab = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || !people[i]) continue;
    const j = i * ch;
    res[0] = SRGB8_TO_LIN[expected[j]]; res[1] = SRGB8_TO_LIN[expected[j + 1]]; res[2] = SRGB8_TO_LIN[expected[j + 2]];
    linToLab(SRGB8_TO_LIN[original[j]], SRGB8_TO_LIN[original[j + 1]], SRGB8_TO_LIN[original[j + 2]], lab);
    applySkinMatchLinear(res, { skinMatch: match }, mask[i], people[i], lab[0]);
    expected[j] = Math.round(linearToSrgb(res[0]) * 255); expected[j + 1] = Math.round(linearToSrgb(res[1]) * 255); expected[j + 2] = Math.round(linearToSrgb(res[2]) * 255);
  }
  applySkinMatchRGBA(actual, match, mask, ch, people, original);
  assert.deepEqual(actual, expected);
});

test('cached person profile observes in-place parameter edits', () => {
  const source = rgbFor(55, 12, 18), original = [
    Math.round(linearToSrgb(source[0]) * 255), Math.round(linearToSrgb(source[1]) * 255), Math.round(linearToSrgb(source[2]) * 255), 255,
  ];
  const match = { version: 2, people: [{ id: 1, zones: [
    { center: 30, deltaL: 0, deltaA: 0, deltaB: 0 }, { center: 55, deltaL: 0, deltaA: 0, deltaB: 0 }, { center: 80, deltaL: 0, deltaA: 0, deltaB: 0 },
  ] }] };
  const first = Uint8Array.from(original);
  applySkinMatchRGBA(first, match, new Uint8Array([255]), 4, new Uint8Array([1]), Uint8Array.from(original));
  match.people[0].zones[1].deltaA = 8;
  const second = Uint8Array.from(original);
  applySkinMatchRGBA(second, match, new Uint8Array([255]), 4, new Uint8Array([1]), Uint8Array.from(original));
  assert.notDeepEqual(second.slice(0, 3), first.slice(0, 3));
});
