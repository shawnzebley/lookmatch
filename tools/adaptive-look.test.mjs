import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveLook, solveAdaptiveLook } from '../engine/adaptive-look.js';
import { measure, prepare } from '../engine/measure.js';
import { processPixelSet } from '../engine/pipeline.js';

function photo({ exposure = 0, red = 0, green = 0, blue = 0, skin = true, neutral = false } = {}) {
  const width = 40, height = 30, n = width * height;
  const data = new Uint8Array(n * 3), skinMask = new Uint8Array(n), skinPeople = new Uint8Array(n), subject = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const person = i < 180 ? 1 : i < 360 ? 2 : 0, isSkin = person > 0;
    const light = (0.48 + (i % 120) / 190) * 2 ** (exposure / 30);
    let rgb;
    if (isSkin) rgb = person === 1 ? [178, 112, 83] : [150, 105, 96];
    else if (neutral && i >= 720 && i < 840) rgb = [128, 128, 128];
    else switch (i % 3) {
      case 0: rgb = [178 + red, 72 + green, 66 + blue]; break;
      case 1: rgb = [76 + red, 151 + green, 72 + blue]; break;
      default: rgb = [64 + red, 105 + green, 181 + blue];
    }
    for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.round(Math.max(0, Math.min(255, rgb[c] * light)));
    if (isSkin && skin) { skinMask[i] = 255; skinPeople[i] = person; }
    if (i < 650) subject[i] = 255;
  }
  const skinPositions = [{ id: 1, x: 0.25, y: 0.5 }, { id: 2, x: 0.75, y: 0.5 }];
  const ps = prepare({ width, height, channels: 3, data }, { skin: skin ? skinMask : null, skinPeople: skin ? skinPeople : null, skinPositions, subject });
  if (skin) { ps.skinMask = skinMask; ps.skinPeople = skinPeople; ps.skinPositions = skinPositions; }
  return ps;
}
function render(ps, params) { return processPixelSet(ps, params); }
function hueError(a, b) { let d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); }
function toneError(a, b) { return [1, 5, 25, 50, 75, 95, 99].reduce((sum, p) => sum + Math.abs(a.tone.pct[p] - b.tone.pct[p]), 0); }
function solid(rgb) {
  const width = 40, height = 30, data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  return prepare({ width, height, channels: 3, data });
}

test('profiles retain reference measurements and serialize deterministically', () => {
  const before = photo(), reference = photo({ exposure: 8, red: 10, green: -5, blue: 4 });
  const a = buildAdaptiveLook(before, reference, { id: 'a', name: 'Reference' });
  const repeat = buildAdaptiveLook(before, reference, { id: 'a', name: 'Reference' });
  assert.equal(JSON.stringify(a), JSON.stringify(repeat));
  assert.ok(a.reference.after.tone.pct[50] > a.reference.before.tone.pct[50]);
  assert.equal(a.targets.skin.L, a.reference.skinAfter.L);
  assert.ok(a.reference.regions?.subject?.n > 200);
  assert.ok(a.reference.regions?.background?.n > 200);
  assert.equal(a.reference.after.adaptiveTransfer.version, 1);
});

test('strength zero is strict identity and tiny strength approaches identity', () => {
  const source = photo({ exposure: -14 }), look = buildAdaptiveLook(photo(), photo({ exposure: 9, red: 8 }));
  const zero = solveAdaptiveLook(source, look, { strength: 0 });
  assert.deepEqual(zero.params, {});
  const tiny = solveAdaptiveLook(source, look, { strength: 0.001, split: false });
  const output = render(source, tiny.params);
  const delta = Math.max(...Array.from({ length: source.n }, (_, i) => Math.hypot(output.L[i] - source.L[i], output.A[i] - source.A[i], output.B[i] - source.B[i])));
  assert.ok(delta < 1, `tiny strength changed a pixel by ${delta.toFixed(2)} Lab`);
});

test('per-photo tone fitting lowers rendered percentile error and adapts controls to exposure', () => {
  const look = buildAdaptiveLook(photo(), photo({ exposure: 8 }), { id: 'tone' });
  const source = photo({ exposure: -8 }), other = photo({ exposure: 12 });
  const solved = solveAdaptiveLook(source, look, { skinProtection: 0, split: false });
  const before = measure(source), after = measure(source, render(source, solved.params)), target = look.reference.after;
  assert.ok(toneError(after, target) < toneError(before, target), `tone error ${toneError(before, target).toFixed(2)} -> ${toneError(after, target).toFixed(2)}`);
  const otherFit = solveAdaptiveLook(other, look, { skinProtection: 0, split: false });
  assert.notDeepEqual(solved.params.referenceTransfer.sourceL, otherFit.params.referenceTransfer.sourceL,
    'different inputs should receive different lightness maps');
});

test('per-photo color fitting improves measured red, green, and blue hue/chroma/luminance', () => {
  const look = buildAdaptiveLook(photo(), photo({ red: 4, green: -3, blue: 3 }), { id: 'color' });
  const source = photo({ red: -3, green: 2, blue: -2 });
  const solved = solveAdaptiveLook(source, look, { skinProtection: 0, split: false });
  const before = measure(source), after = measure(source, render(source, solved.params)), target = look.reference.after;
  for (const band of ['red', 'green', 'blue']) {
    const score = (s) => hueError(s.bands[band].hue, target.bands[band].hue)
      + Math.abs(s.bands[band].chroma - target.bands[band].chroma)
      + Math.abs(s.bands[band].lumRel - target.bands[band].lumRel) / 5;
    assert.ok(score(after) < score(before), `${band} hue/chroma/relative-luminance error ${score(before).toFixed(2)} -> ${score(after).toFixed(2)}`);
  }
  const other = photo({ red: 10, green: -8, blue: 7 });
  const otherFit = solveAdaptiveLook(other, look, { skinProtection: 0, split: false });
  assert.notDeepEqual(solved.params.referenceTransfer, otherFit.params.referenceTransfer,
    'different inputs should receive different Lab color fits');
});

test('adaptive palette fits non-skin RGB bands without coloring neutral fabric', () => {
  const look = buildAdaptiveLook(photo({ neutral: true }), photo({ neutral: true, red: 5, green: -4, blue: 4 }));
  const source = photo({ neutral: true, red: -5, green: 5, blue: -4 });
  const result = solveAdaptiveLook(source, look, { skinProtection: 0, split: false });
  const rendered = render(source, result.params);
  const before = measure(source), after = measure(source, rendered), target = look.reference.after;
  for (const band of ['red', 'green', 'blue']) {
    const error = (s) => hueError(s.bandsAdaptive[band].hue, target.bandsAdaptive[band].hue) / 3
      + Math.abs(s.bandsAdaptive[band].chroma - target.bandsAdaptive[band].chroma)
      + Math.abs(s.bandsAdaptive[band].lumRel - target.bandsAdaptive[band].lumRel);
    assert.ok(error(after) < error(before), `${band} non-skin band error ${error(before).toFixed(2)} -> ${error(after).toFixed(2)}`);
  }
  const neutralChroma = Array.from({ length: 120 }, (_, offset) => 720 + offset)
    .reduce((sum, i) => sum + Math.hypot(rendered.A[i], rendered.B[i]), 0) / 120;
  assert.ok(neutralChroma < 6, `neutral fabric gained ${neutralChroma.toFixed(2)} Lab chroma`);
});

test('supported aqua content can cross Lab hue sectors smoothly toward the reference', () => {
  const source = solid([24, 120, 125]), reference = solid([25, 100, 135]);
  const look = buildAdaptiveLook(source, reference);
  const fit = solveAdaptiveLook(source, look, { split: false, skinProtection: 0 });
  const before = measure(source).bandsAdaptive.aqua;
  const after = measure(source, render(source, fit.params)).bandsAdaptive.aqua;
  const goal = measure(reference).bandsAdaptive.aqua;
  assert.ok(fit.params.referenceTransfer.bandCorrections?.length, 'supported band received a smooth correction');
  assert.ok(hueError(after.hue, goal.hue) + 15 < hueError(before.hue, goal.hue),
    `aqua Lab hue ${hueError(before.hue, goal.hue).toFixed(1)} -> ${hueError(after.hue, goal.hue).toFixed(1)} degrees`);
});

test('adaptive band support is fixed while brightness changes and fitted curves stay increasing', () => {
  const source = photo({ exposure: -5, neutral: true });
  const bright = measure(source, render(source, { exposure: 2 }));
  const before = measure(source);
  for (const band of ['red', 'green', 'blue']) {
    assert.equal(bright.bandsAdaptive[band].weight, before.bandsAdaptive[band].weight);
  }
  const look = buildAdaptiveLook(photo({ exposure: -8 }), photo({ exposure: 9, red: 10 }));
  const fit = solveAdaptiveLook(source, look, { split: false, skinProtection: 0 });
  const transfer = fit.params.referenceTransfer;
  assert.equal(fit.adaptive.fitVersion, 3);
  for (let i = 1; i < transfer.targetL.length; i++) {
    assert.ok(transfer.targetL[i] + 1e-6 >= transfer.targetL[i - 1], `lightness map reverses at ${i}`);
  }
});

test('insufficient non-skin pixels leave color unchanged and report a lighting-only fit', () => {
  const look = buildAdaptiveLook(photo(), photo({ exposure: 6, red: 12 }));
  const source = photo();
  source.skinMask.fill(255);
  const fit = solveAdaptiveLook(source, look, { split: false, skinProtection: 0 });
  const transfer = fit.params.referenceTransfer;
  assert.match(fit.adaptive.warning, /palette support is too small/);
  assert.deepEqual(transfer.abScale, [1, 1]);
  assert.deepEqual(transfer.hueSectors, []);
  assert.deepEqual(transfer.targetMean, transfer.sourceMean);
});

test('detected skin mask keeps those pixels out of adaptive palette measurements', () => {
  const source = photo({ skin: false });
  const before = measure(source).bandsAdaptive.blue.weight;
  source.skinMask = new Uint8Array(source.n);
  for (let i = 360; i < 720; i++) if (i % 3 === 2) source.skinMask[i] = 255;
  const after = measure(source).bandsAdaptive.blue.weight;
  assert.ok(after < before, `blue support did not exclude detected skin: ${before} -> ${after}`);
});

test('skin fitting moves masked people toward stored reference appearance and retains reference IDs', () => {
  const source = photo(), reference = photo({ exposure: 4, red: 12, green: -6, blue: -2 });
  const look = buildAdaptiveLook(photo(), reference, { id: 'skin' });
  const result = solveAdaptiveLook(source, look, { split: false, skinProtection: 1 });
  assert.deepEqual(result.referenceStats.skinMatch, look.reference.skinAfter);
  assert.ok(result.params.skinMatch?.people?.length);
  assert.ok(result.params.skinMatch.people.every((p) => look.reference.skinAfter.people.some((ref) => ref.id === p.referenceId)));
  const plain = { ...result.params }; delete plain.skinMatch;
  const beforeSkin = measure(source).skinMatch, plainSkin = measure(source, render(source, plain)).skinMatch, fittedSkin = measure(source, render(source, result.params)).skinMatch;
  const error = (x) => Math.hypot(x.L - look.reference.skinAfter.L, x.a - look.reference.skinAfter.a, x.b - look.reference.skinAfter.b);
  assert.ok(error(fittedSkin) < error(plainSkin), `skin error ${error(plainSkin).toFixed(2)} -> ${error(fittedSkin).toFixed(2)}`);
  assert.ok(beforeSkin, 'synthetic mask provides a measurable skin sample');
});

test('missing masks and incomplete legacy stats produce finite controls and explicit fallback warning', () => {
  const noSkin = photo({ skin: false }), look = buildAdaptiveLook(photo({ skin: false }), photo({ skin: false, red: 8 }));
  const missing = solveAdaptiveLook(noSkin, look);
  assert.equal(missing.adaptive.maskAvailable, false);
  assert.match(missing.adaptive.warning, /Skin mask unavailable/);
  const legacy = { ...look, reference: { ...look.reference, after: null }, params: { exposure: 0.3, hue_red: 4 } };
  const fallback = solveAdaptiveLook(noSkin, legacy);
  assert.match(fallback.adaptive.warning, /legacy fallback/);
  assert.equal(fallback.targets, null);
  for (const value of Object.values(fallback.params)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  const withSkin = buildAdaptiveLook(photo(), photo({ red: 8 }));
  withSkin.reference.after.skinMatch = null;
  withSkin.reference.skinAfter = null;
  const noReferenceSkin = solveAdaptiveLook(photo(), withSkin, { split: false });
  assert.match(noReferenceSkin.adaptive.warning, /Reference skin measurements unavailable/);
});

test('split false skips regional fitting and valid reference masks produce editable regional controls', () => {
  const look = buildAdaptiveLook(photo(), photo({ exposure: 8, red: 8 }));
  const ps = photo({ exposure: -10 });
  const skipped = solveAdaptiveLook(ps, look, { split: false, skinProtection: 0 });
  assert.equal(skipped.params.local, undefined);
  const fitted = solveAdaptiveLook(ps, look, { skinProtection: 0 });
  assert.ok(fitted.params.local?.subject || fitted.params.local?.background);
  assert.ok(fitted.adaptive.backgroundFitted);

  const subjectIdx = Int32Array.from(Array.from({ length: ps.n }, (_, i) => i).filter(i => ps.subject[i] >= 191));
  const backgroundIdx = Int32Array.from(Array.from({ length: ps.n }, (_, i) => i).filter(i => ps.subject[i] < 64));
  const beforeSubject = measure(ps, ps, subjectIdx), beforeBackground = measure(ps, ps, backgroundIdx);
  const output = measure(ps, render(ps, fitted.params), subjectIdx), outputBackground = measure(ps, render(ps, fitted.params), backgroundIdx);
  const subjectTarget = look.reference.after.maskedRegions.subject.tone.pct[50];
  const backgroundTarget = look.reference.after.maskedRegions.background.tone.pct[75];
  assert.ok(Math.abs(output.tone.pct[50] - subjectTarget) < Math.abs(beforeSubject.tone.pct[50] - subjectTarget),
    `subject L50 ${beforeSubject.tone.pct[50].toFixed(2)} -> ${output.tone.pct[50].toFixed(2)}, target ${subjectTarget.toFixed(2)}`);
  assert.ok(Math.abs(outputBackground.tone.pct[75] - backgroundTarget) < Math.abs(beforeBackground.tone.pct[75] - backgroundTarget),
    `background L75 ${beforeBackground.tone.pct[75].toFixed(2)} -> ${outputBackground.tone.pct[75].toFixed(2)}, target ${backgroundTarget.toFixed(2)}`);
});
