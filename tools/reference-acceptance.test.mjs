import test from 'node:test';
import assert from 'node:assert/strict';
import { labToLin } from '../engine/color.js';
import { regionStats } from '../engine/measure.js';
import { referenceAcceptance } from '../engine/reference-acceptance.js';

function fixture({ people = [1], values = [30, 50, 75], width = 30, height = 30 } = {}) {
  const n = width * height;
  const ps = { n, width, height, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n), skinMask: new Uint8Array(n), skinPeople: new Uint8Array(n), subject: new Uint8Array(n), masks: { regionTint: new Uint8Array(n) } };
  const perPerson = Math.floor(n / people.length);
  for (let i = 0; i < n; i++) {
    const p = people[Math.min(people.length - 1, Math.floor(i / perPerson))];
    ps.skinMask[i] = 255; ps.skinPeople[i] = p; ps.L[i] = values[Math.floor((i % perPerson) / Math.max(1, perPerson / values.length))] ?? values.at(-1);
    ps.A[i] = 12 + p * 3; ps.B[i] = 18 + p * 2;
    ps.subject[i] = i < n / 2 ? 255 : 0;
    const rgb = labToLin(ps.L[i], ps.A[i], ps.B[i], [0, 0, 0]);
    ps.lr[i] = Math.max(0, Math.min(1, rgb[0])); ps.lg[i] = Math.max(0, Math.min(1, rgb[1])); ps.lb[i] = Math.max(0, Math.min(1, rgb[2]));
  }
  const cur = { L: ps.L.slice(), A: ps.A.slice(), B: ps.B.slice(), lr: ps.lr.slice(), lg: ps.lg.slice(), lb: ps.lb.slice() };
  const peopleTargets = people.map((id) => ({ id: id + 100, zones: {
    shadow: { L: 30, a: 12 + id * 3, b: 18 + id * 2, pixels: 30 },
    midtone: { L: 50, a: 12 + id * 3, b: 18 + id * 2, pixels: 30 },
    lit: { L: 75, a: 12 + id * 3, b: 18 + id * 2, pixels: 30 },
  } }));
  const regions = regionStats(ps, ps, null, { details: false });
  const target = { skinMatch: { version: 2, people: peopleTargets }, regions };
  const mapping = { version: 2, people: people.map((id) => ({ id, referenceId: id + 100, zones: [] })) };
  return { ps, cur, target, mapping };
}
function report(f) { return referenceAcceptance(f.ps, f.cur, f.target, { skinMatch: f.mapping }); }
function setPerson(f, id, fn) { for (let i = 0; i < f.ps.n; i++) if (f.ps.skinPeople[i] === id) fn(i); }

test('accepts rendered measurements matching mapped per-person zones', () => {
  const f = fixture();
  const r = report(f);
  assert.equal(r.status, 'accepted');
  assert.equal(r.accepted, true);
  assert.equal(r.scope, 'rendered-preview');
});

test('rejects excessive skin brightness error', () => {
  const f = fixture(); setPerson(f, 1, (i) => { f.cur.L[i] += 8; });
  assert.equal(report(f).status, 'rejected');
});

test('rejects wrong skin chroma', () => {
  const f = fixture(); setPerson(f, 1, (i) => { f.cur.A[i] += 10; });
  assert.ok(report(f).checks.some((c) => c.key.endsWith(':chroma') && c.status === 'fail'));
});

test('small face clipping is measured per person and cannot be diluted', () => {
  const f = fixture({ people: [1, 2] });
  setPerson(f, 1, (i) => { if (i % 30 === 0) f.cur.lr[i] = 1; });
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:new-clipping' && c.status === 'fail'));
});

test('rejects collapsed local skin luminance detail', () => {
  const f = fixture(); f.cur.L.fill(50);
  assert.ok(report(f).checks.some((c) => c.key === 'person:1:detail-loss' && c.status === 'fail'));
});

test('missing masks and invalid targets remain unverified', () => {
  const f = fixture(); delete f.ps.skinMask;
  assert.equal(report(f).status, 'unverified');
  const g = fixture(); g.target.skinMatch.people[0].zones.lit.L = NaN;
  assert.equal(report(g).status, 'unverified');
});

test('strength interpolates from source measurements toward the reference', () => {
  const f = fixture();
  f.target.skinMatch.people[0].zones.shadow.L = 45;
  f.target.skinMatch.people[0].zones.midtone.L = 65;
  f.target.skinMatch.people[0].zones.lit.L = 90;
  // At half strength, output matches the midpoint between source and reference.
  setPerson(f, 1, (i) => { f.cur.L[i] = f.ps.L[i] + (f.target.skinMatch.people[0].zones[f.ps.L[i] < 40 ? 'shadow' : f.ps.L[i] < 65 ? 'midtone' : 'lit'].L - f.ps.L[i]) * 0.5; });
  assert.equal(referenceAcceptance(f.ps, f.cur, f.target, { strength: 0.5, skinMatch: f.mapping }).status, 'accepted');
});

test('explicit wrong face correspondence fails despite overall median match', () => {
  const f = fixture({ people: [1, 2] });
  for (const p of f.target.skinMatch.people) for (const z of Object.values(p.zones)) { z.a += p.id === 101 ? 20 : -20; }
  for (const p of f.mapping.people) p.referenceId = p.referenceId === 101 ? 102 : 101;
  // Output remains identical to its own source, while the explicit map points each source at the other face.
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:shadow:chroma' && c.status === 'fail'));
});

test('one failed zone rejects even when the other zones match', () => {
  const f = fixture();
  setPerson(f, 1, (i) => { if (f.ps.L[i] > 70) f.cur.A[i] += 15; });
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:lit:chroma' && c.status === 'fail'));
});

test('new clipping in one RGB channel fails while rendered L remains below 99.5', () => {
  const f = fixture();
  setPerson(f, 1, (i) => { if (i % 50 === 0) f.cur.lr[i] = 1; });
  assert.ok(Math.max(...f.cur.L) < 99.5);
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:new-clipping' && c.status === 'fail'));
});

test('existing blue clipping cannot hide newly clipped red pixels', () => {
  const f = fixture();
  setPerson(f, 1, (i) => {
    if (i % 50 === 0) f.ps.lb[i] = 1; // pre-existing source clipping in blue
    if (i % 50 === 1) f.cur.lr[i] = 1; // newly clipped red on separate pixels
  });
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:new-clipping' && c.status === 'fail'));
});

test('empty or malformed reference regions are unverified', () => {
  const f = fixture();
  f.target.regions = { subject: { n: 0, L50: 50 }, background: { n: 0, L50: 50 }, sep: 0 };
  assert.ok(report(f).checks.some((c) => c.key === 'subject-background-separation' && c.status === 'unverified'));
  const g = fixture(); delete g.target.regions.background;
  assert.ok(report(g).checks.some((c) => c.key === 'subject-background-separation' && c.status === 'unverified'));
});

test('clipping fails even when no source-detail neighborhoods qualify', () => {
  const f = fixture(); f.ps.L.fill(50); f.cur.L.fill(50);
  setPerson(f, 1, (i) => { if (i % 50 === 0) f.cur.lg[i] = 0; });
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:new-clipping' && c.status === 'fail'));
  assert.ok(r.checks.some((c) => c.key === 'person:1:detail-loss' && c.status === 'unverified'));
});

test('localized detail loss is not diluted by flat neighborhoods elsewhere', () => {
  const f = fixture({ width: 40, height: 30 });
  const cx = 20, cy = 15;
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
    const i = y * f.ps.width + x;
    f.ps.L[i] = (x + y) % 2 ? 44 : 56;
    f.cur.L[i] = 50;
  }
  const r = report(f);
  assert.ok(r.checks.some((c) => c.key === 'person:1:detail-loss' && c.status === 'fail'));
});

test('missing RGB arrays, invalid target pixels, and invalid strength are unverified', () => {
  const f = fixture(); delete f.cur.lb;
  assert.equal(report(f).status, 'unverified');
  const g = fixture(); delete g.target.skinMatch.people[0].zones.shadow.pixels;
  assert.ok(report(g).checks.some((c) => c.key === 'person:1:shadow' && c.status === 'unverified'));
  const h = fixture();
  assert.equal(referenceAcceptance(h.ps, h.cur, h.target, { strength: NaN, skinMatch: h.mapping }).status, 'unverified');
});
