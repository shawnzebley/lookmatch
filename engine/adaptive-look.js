// A reference pair defines measured appearance targets; every application refits controls to its own pixels.
import { measure } from './measure.js';
import { solve } from './solver.js';
import { processPixelSet, SLIDERS } from './pipeline.js';
import { fitSkinMatch, skinStats } from './skin-match.js';
import { fitReferenceRegions } from './regions.js';
import { regionStats as splitRegionStats, regionUsable } from './measure.js';
import { referenceRegionTargets, solveMaskedReference } from './masked-reference.js';
import { adaptiveReferenceTargets, solveAdaptiveTransfer } from './adaptive-transfer.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function signedHueParams(params) {
  for (const key of Object.keys(params)) if (key.startsWith('hue_') && Number.isFinite(params[key])) params[key] = ((params[key] + 180) % 360 + 360) % 360 - 180;
  for (const region of ['subject', 'background']) if (params.local?.[region]) signedHueParams(params.local[region]);
  return params;
}
function pixelBuffers(n) { return { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) }; }
function regionStats(ps, cur, wantSubject) {
  const mask = ps.subject;
  const skin = ps.masks?.skin;
  if (!mask && !skin) return null;
  const idx = [];
  for (let i = 0; i < ps.n; i++) {
    const isSubject = mask ? mask[i] >= 191 : Boolean(skin?.[i]);
    if (isSubject === wantSubject) idx.push(i);
  }
  return idx.length >= 20 ? measure(ps, cur, Int32Array.from(idx)) : null;
}
function deltaStats(a, b) {
  if (!a || !b) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(a)) {
    const d = deltaStats(value, b[key]);
    if (d !== undefined) out[key] = d;
  }
  return out;
}
function fitPerPerson(ps, cur, targetStats, move) {
  // Let fitSkinMatch perform its position-based pairing and retain catalogue reference IDs.
  return fitSkinMatch(ps, cur, targetStats, { move });
}

function fitAdaptiveRegions(ps, params, look, amount, enabled) {
  if (enabled === false) return { params, regions: null, warning: null };
  if (!ps.subject) return { params, regions: null, warning: 'Subject mask unavailable; reference regional fit was skipped.' };
  const ownRegions = splitRegionStats(ps, ps, null), referenceRegions = look.reference?.after?.regions || look.reference?.regions;
  if (!regionUsable(ownRegions) || !regionUsable(referenceRegions)) {
    return { params, regions: null, warning: 'Reference subject/background measurements are unavailable or too small.' };
  }
  const fitted = fitReferenceRegions(ps, params, referenceRegions, { move: 0.7 * amount });
  return fitted ? { params: fitted.params, regions: fitted.regions, warning: null }
    : { params, regions: null, warning: 'Subject/background masks do not support a regional reference fit.' };
}

/** Build a versioned profile from paired images from the same scene. */
export function buildAdaptiveLook(beforePs, afterPs, { id, name, thumb = null, beforeThumb = null, source = null } = {}) {
  const before = measure(beforePs), after = measure(afterPs);
  const fitted = solve(beforePs, before, after, { strength: 1 });
  const params = signedHueParams(clone(fitted.params));
  const transformLimits = { exposure: [-1, 1], temp: [-22, 22], tint: [-20, 20], saturation: [-75, 35], vibrance: [-40, 35] };
  for (const [key, bounds] of Object.entries(transformLimits)) params[key] = clamp(params[key] || 0, ...bounds);
  for (const key of Object.keys(params)) {
    if (key.startsWith('hue_')) params[key] = clamp(params[key], -22, 22);
    if (key.startsWith('sat_')) params[key] = clamp(params[key], -40, 40);
    if (key.startsWith('lum_')) params[key] = clamp(params[key], -20, 20);
  }
  const beforeSkin = skinStats(beforePs), afterSkin = skinStats(afterPs);
  const skinMaskAvailable = Boolean(beforePs.skinMask && afterPs.skinMask && beforeSkin && afterSkin);
  const bgBefore = regionStats(beforePs, beforePs, false), bgAfter = regionStats(afterPs, afterPs, false);
  const subBefore = regionStats(beforePs, beforePs, true), subAfter = regionStats(afterPs, afterPs, true);
  return {
    version: 1, id, name, thumb, beforeThumb, source,
    params, toneCurve: params.curve,
    reference: { before, after: { ...after, regions: splitRegionStats(afterPs, afterPs, null), maskedRegions: referenceRegionTargets(afterPs), adaptiveTransfer: adaptiveReferenceTargets(afterPs) }, skinBefore: beforeSkin, skinAfter: afterSkin,
      regions: splitRegionStats(afterPs, afterPs, null),
      backgroundBefore: regionStats(beforePs, beforePs, false), backgroundAfter: regionStats(afterPs, afterPs, false) },
    targets: {
      skin: skinMaskAvailable ? afterSkin : null,
      background: deltaStats(bgAfter, bgBefore),
      subject: deltaStats(subAfter, subBefore),
    },
    limits: { transform: transformLimits, curveSlope: [0.3, 1.8], normaliseExposure: 0.75, normaliseTemp: 30, normaliseTint: 25, exposure: [-3, 3], temp: [-100, 100], tint: [-100, 100], backgroundExposure: 0.25, backgroundTemp: 10, backgroundTint: 10, backgroundSaturation: 20, maxGuardScale: 1, skinDeltaL: 8, skinDeltaAB: 3 },
    metadata: { skinMaskAvailable, sourceMaskMethod: beforePs.subject ? 'subject-mask' : 'color-window' },
  };
}

/** Fit this reference appearance to one PixelSet. Amount zero is a strict identity operation. */
export function solveAdaptiveLook(ps, look, { strength = 1, skinProtection = 1, scene = null, split = true } = {}) {
  const amount = clamp(Number.isFinite(strength) ? strength : 1, 0, 1);
  const protection = clamp(Number.isFinite(skinProtection) ? skinProtection : 1, 0, 1);
  if (amount === 0) return {
    params: {}, targets: null, normalise: { exposure: 0, temp: 0, tint: 0 }, timings: { total: 0, evals: 0 }, guardScale: 1,
    adaptive: { id: look.id, fitVersion: look.reference?.after?.adaptiveTransfer?.version === 1 ? 3 : 2, skinProtected: false, maskAvailable: Boolean(ps.skinMask), limits: clone(look.limits || {}), warning: null },
  };
  const own = measure(ps), reference = look.reference?.after;
  const limits = look.limits || { maxGuardScale: 1, skinDeltaL: 8, skinDeltaAB: 12 };
  let normalized, params, warning = null;
  const measuredReference = !!(reference?.tone?.pct && reference.wb && reference.zones && reference.bands && reference.color);
  if (measuredReference) {
    normalized = solveAdaptiveTransfer(ps, reference, amount, split !== false);
    normalized ||= reference.maskedRegions && split !== false
      ? solveMaskedReference(ps, reference, { strength: amount, scene, adaptive: true })
      : null;
    normalized ||= solve(ps, own, reference, { strength: amount, scene, adaptive: true });
    params = signedHueParams({ ...normalized.params });
    warning = normalized.warning || null;
  } else {
    warning = 'Reference measurements are incomplete; using saved look controls as a legacy fallback.';
    params = {};
    for (const [key, value] of Object.entries(look.params || {})) {
      if (Array.isArray(value)) params[key] = value.map(([x, y]) => [x, x + (y - x) * amount]);
      else if (typeof value === 'number' && Number.isFinite(value)) params[key] = key === 'curveSaturation' ? 100 + (value - 100) * amount : SLIDERS.find(s => s.key === key)?.hue ? value : value * amount;
    }
    normalized = { timings: { total: 0, evals: 0 } };
  }
  for (const slider of SLIDERS) if (Number.isFinite(params[slider.key])) params[slider.key] = clamp(params[slider.key], ...slider.ui);
  const regional = params.local
    ? { params, regions: normalized.regions || null, warning: null }
    : fitAdaptiveRegions(ps, params, look, amount, split);
  params = regional.params;
  const cur = pixelBuffers(ps.n);
  processPixelSet(ps, params, null, cur);
  const currentSkin = skinStats(ps);
  const hasReferenceSkinStats = reference && Object.hasOwn(reference, 'skinMatch');
  const referenceSkin = hasReferenceSkinStats ? reference.skinMatch : look.reference?.skinAfter || look.targets?.skin || null;
  let skinMatch = null;
  if (protection > 0 && currentSkin && referenceSkin) {
    skinMatch = fitPerPerson(ps, cur, referenceSkin, protection * amount);
    if (skinMatch) params.skinMatch = skinMatch;
  }
  return {
    params, targets: normalized.targets || null,
    referenceStats: { ...reference, skinMatch: referenceSkin || null },
    normalise: { exposure: params.exposure || 0, temp: params.temp || 0, tint: params.tint || 0 }, regions: regional.regions,
    timings: normalized.timings, guardScale: 1, fitVersion: measuredReference ? (params.referenceMethod === 'lab-distribution' ? 3 : 2) : 1,
    adaptive: { id: look.id, fitVersion: measuredReference ? (params.referenceMethod === 'lab-distribution' ? 3 : 2) : 1, skinProtected: Boolean(skinMatch?.people?.length || skinMatch?.deltaA || skinMatch?.deltaB || skinMatch?.deltaL), maskAvailable: Boolean(ps.skinMask && currentSkin), backgroundFitted: !!regional.regions,
      limits: clone(limits), warning: [warning, regional.warning,
        ps.skinMask ? (currentSkin ? null : 'Skin mask has too few confident pixels for correction.') : 'Skin mask unavailable; skin protection was skipped.',
        protection > 0 && currentSkin && !referenceSkin ? 'Reference skin measurements unavailable; skin matching was skipped.' : null,
        protection > 0 && referenceSkin?.version === 2 && !referenceSkin.people?.length ? 'Reference has no supported per-person skin measurements.' : null,
      ].filter(Boolean).join(' ') || null },
  };
}
