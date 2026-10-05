import { measure, regionStats } from './measure.js';
import { SLIDER_BY_KEY } from './pipeline.js';
import { fitSkinMatch, skinStats } from './skin-match.js';
import { adaptiveAppearanceChecks } from './adaptive-check.js';

function skinError(ps, cur, reference, match, strength) {
  const original = skinStats(ps), actual = skinStats(ps, cur);
  if (!original || !actual) return Infinity;
  let sum = 0, count = 0;
  const add = (before, after, target) => {
    for (const key of ['L', 'a', 'b']) if ([before?.[key], after?.[key], target?.[key]].every(Number.isFinite)) {
      sum += (after[key] - before[key] - strength * (target[key] - before[key])) ** 2; count++;
    }
  };
  if (match.version === 2) {
    for (const person of match.people) {
      const source = original.people.find((p) => p.id === person.id), got = actual.people.find((p) => p.id === person.id);
      const target = reference.people.find((p) => p.id === person.referenceId);
      for (const zone of person.zones) add(source?.zones[zone.name], got?.zones[zone.name], target?.zones?.[zone.name]);
    }
  } else add(original, actual, reference);
  return count ? sum / count : Infinity;
}

// Refine against pixels from the renderer, including quantization and finishing.
// The pass count limits runtime; it never scales an edit back to preserve source appearance.
export function renderedTargetError(ps, cur, targets, { regional = null, strength = 1, appearanceReference = null } = {}) {
  const got = measure(ps, cur);
  let sum = 0, count = 0;
  const add = (a, b, weight = 1) => {
    if (Number.isFinite(a) && Number.isFinite(b)) { sum += weight * (a - b) ** 2; count += weight; }
  };
  // Adaptive refinement must consider supported individual colors as well as tone.
  if (appearanceReference) {
    const checks = adaptiveAppearanceChecks(ps, cur, appearanceReference, { strength });
    for (const check of checks) if (Number.isFinite(check.value)) {
      const limit = check.tolerance;
      if (limit > 0) { sum += 16 * (check.value / limit) ** 2; count++; }
    }
  }
  if (regional?.subject?.tone && regional?.background?.tone && ps.subject) {
    const before = regionStats(ps), after = regionStats(ps, cur);
    for (const name of ['subject', 'background']) {
      const original = before[name], reference = regional[name], actual = after[name];
      if (original.n < 20 || reference.n < 20) continue;
      for (const p of [1, 5, 25, 50, 75, 95, 99]) {
        add(actual.tone.pct[p], original.tone.pct[p] + strength * (reference.tone.pct[p] - original.tone.pct[p]));
      }
      if (!targets.adaptive) for (const key of ['a', 'b', 'C']) add(actual[key], original[key] + strength * (reference[key] - original[key]));
    }
    if (count) return sum / count;
  }
  for (const p of [1, 5, 25, 50, 75, 95, 99]) add(got.tone.pct[p], targets.tone.pct[p]);
  add(got.wb.a, targets.wb.a, targets.wb.weight);
  add(got.wb.b, targets.wb.b, targets.wb.weight);
  if (!targets.adaptive) add(got.color.meanChroma, targets.color.meanChroma);
  for (const [name, target] of Object.entries(targets.zones || {})) {
    add(got.zones[name]?.a, target.a, target.weight);
    add(got.zones[name]?.b, target.b, target.weight);
  }
  return count ? sum / count : Infinity;
}

export function refineReference(ps, params, targets, render, { skinTarget = null, regional = null, strength = 1, skinStrength = strength, appearanceReference = null, passes = 2 } = {}) {
  let best = structuredClone(params), evaluations = 0;
  const preservesColors = params.referenceTransfer?.preserveColors
    || ['subject', 'background'].some(name => params.local?.[name]?.referenceTransfer?.preserveColors);
  const evaluate = (p) => { evaluations++; return renderedTargetError(ps, render(p), targets, { regional, strength, appearanceReference }); };
  const initial = evaluate(best);
  let error = initial;
  // Tone first, white balance next, color intensity last. All candidates stay editable.
  for (let pass = 0; pass < passes; pass++) {
    for (const scope of best.local && regional ? ['subject', 'background'] : [null]) {
    for (const [key, initialStep] of [['exposure', 0.12], ['contrast', 12], ['highlights', 20], ['shadows', 20], ['temp', 4], ['tint', 4], ['saturation', 5]]) {
      // Guarded transfer already fits tone within each color's gamut. Any
      // later scene-wide adjustment can bleach it again, including exposure.
      // Keep those automatic fits intact; manual controls remain unrestricted.
      if (preservesColors) continue;
      const step = initialStep / (pass + 1), range = SLIDER_BY_KEY[key].ui;
      let winner = best, winnerError = error;
      for (const direction of [-1, 1]) {
        const candidate = structuredClone(best);
        const destination = scope ? candidate.local[scope] : candidate;
        const original = scope ? best.local[scope] : best;
        destination[key] = Math.max(range[0], Math.min(range[1], (original[key] || 0) + direction * step));
        if (destination[key] === (original[key] || 0)) continue;
        const score = evaluate(candidate);
        if (score < winnerError) { winner = candidate; winnerError = score; }
      }
      best = winner; error = winnerError;
    }
    }
  }
  // Skin is fitted after the final global/region/finish settings. Re-render and fit residual
  // corrections so LUT interpolation, mask feathering and finishing are part of the result.
  if (skinTarget) {
    delete best.skinMatch;
    for (let pass = 0; pass < 3; pass++) {
      const current = render(best);
      const fit = fitSkinMatch(ps, current, skinTarget, { move: skinStrength });
      if (!fit) break;
      const previous = best.skinMatch;
      if (previous?.version === 2 && fit.version === 2) {
        for (const person of fit.people) for (const zone of person.zones) {
          const old = previous.people.find((p) => p.id === person.id)?.zones.find((z) => z.name === zone.name);
          if (old) for (const key of ['deltaL', 'deltaA', 'deltaB']) zone[key] += old[key] || 0;
        }
      } else if (previous && !previous.version && !fit.version) {
        for (const key of ['deltaL', 'deltaA', 'deltaB']) fit[key] += previous[key] || 0;
      }
      const candidate = { ...best, skinMatch: fit };
      if (skinError(ps, render(candidate), skinTarget, fit, skinStrength) >= skinError(ps, current, skinTarget, fit, skinStrength)) {
        // A self-reference may need no correction, but acceptance still needs the fitted correspondence.
        if (!previous) {
          const identity = structuredClone(fit);
          const zones = identity.version === 2 ? identity.people.flatMap((p) => p.zones) : [identity];
          for (const zone of zones) for (const key of ['deltaL', 'deltaA', 'deltaB']) zone[key] = 0;
          best.skinMatch = identity;
        }
        break;
      }
      best = candidate;
    }
  }
  return { params: best, refinement: { passes, evaluations, before: initial, after: evaluate(best) } };
}
