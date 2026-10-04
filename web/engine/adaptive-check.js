// Measurements of final pixels, independent of the fitting algorithm.
import { BANDS, measure } from './measure.js';
import { computeTargets } from './solver.js';
import { wrapDeg } from './color.js';

export function adaptiveAppearanceChecks(ps, cur, reference, { strength = 1 } = {}) {
  if (!reference?.tone?.pct || !reference.bands || !reference.zones || !reference.wb || !reference.color) {
    return [{ key: 'adaptive-targets', label: 'Adaptive appearance targets', status: 'unverified', reason: 'Reference measurements are unavailable.' }];
  }
  const checks = [];
  const scopes = [];
  if (reference.adaptiveSplit !== false && reference.maskedRegions?.version === 1 && ps.subject) {
    for (const name of ['subject', 'background']) {
      const indices = Int32Array.from(Array.from({ length: ps.n }, (_, i) => i).filter(i => name === 'subject' ? ps.subject[i] >= 191 : ps.subject[i] < 64));
      if (indices.length >= 200 && reference.maskedRegions[name]?.tone) scopes.push({ name, before: measure(ps, ps, indices), after: measure(ps, cur, indices), reference: reference.maskedRegions[name] });
    }
  }
  if (scopes.length !== 2) scopes.splice(0, scopes.length, { name: '', before: measure(ps), after: measure(ps, cur), reference });
  for (const scope of scopes) {
    const { before, after } = scope, target = computeTargets(before, scope.reference, { strength, adaptive: true });
    const sourcePalette = before.bandsAdaptive || before.bandsBg || before.bands;
    const renderedPalette = after.bandsAdaptive || after.bandsBg || after.bands;
    const prefix = scope.name ? `${scope.name}:` : '', labelPrefix = scope.name ? `${scope.name} ` : '';
    const add = (key, label, actual, goal, limit, unit, circular = false) => {
      const error = Math.abs(circular ? wrapDeg(actual - goal) : actual - goal);
      const valid = Number.isFinite(actual) && Number.isFinite(goal) && Number.isFinite(error);
      checks.push({ key: prefix + key, label: labelPrefix + label, status: valid ? error <= limit ? 'pass' : 'fail' : 'unverified', value: valid ? error : null,
        tolerance: limit, limit: `<=${limit} ${unit}`, reason: valid ? `Measured ${actual.toFixed(2)}, target ${goal.toFixed(2)}; error ${error.toFixed(2)} ${unit}.` : 'Measurements are unavailable.' });
    };
    for (const p of [5, 25, 50, 75, 95]) add(`adaptive-tone:${p}`, `Tone percentile ${p}`, after.tone.pct[p], target.tone.pct[p], 4, 'L*');
    for (const name of BANDS) {
      const aim = target.bands[name];
      if (!aim) {
        // No invented target for colors absent from either image.
        if (sourcePalette[name].weight >= 0.015) checks.push({ key: `${prefix}adaptive-band:${name}`, label: `${labelPrefix}${name} reference support`, status: 'unverified',
          reason: 'This photo contains the color, but the reference has too little support to match it.' });
        continue;
      }
      const actual = renderedPalette[name];
      add(`adaptive-band:${name}:hue`, `${name} hue`, actual.hue, aim.hue, 12, 'degrees', true);
      add(`adaptive-band:${name}:chroma`, `${name} color intensity`, actual.chroma, aim.chroma, 5, 'Lab chroma');
      add(`adaptive-band:${name}:light`, `${name} relative brightness`, actual.lumRel, aim.lumRel, 5, 'L*');
    }
  }
  return checks;
}

export function addAdaptiveAppearanceChecks(acceptance, checks) {
  const all = [...acceptance.checks, ...checks];
  const status = all.some(c => c.status === 'fail') ? 'rejected' : all.some(c => c.status === 'unverified') ? 'unverified' : 'accepted';
  return { ...acceptance, checks: all, status, accepted: status === 'accepted', issues: all.filter(c => c.status === 'fail').map(c => c.reason) };
}
