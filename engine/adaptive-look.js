// A reference pair defines an editable look; every application solves a small exposure/WB
// normalisation for the new photo before applying that look.
import { measure } from './measure.js';
import { solve, solvePreset, lm } from './solver.js';
import { processPixelSet, SLIDERS, curveLUT } from './pipeline.js';
import { fitSkinMatch, skinStats } from './skin-match.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function pixelBuffers(n) { return { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) }; }
function smoothLookCurve(points, channel = false) {
  if (!points) return [[0, 0], [255, 255]];
  const lut = curveLUT(points), xs = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  const values = xs.map(x => {
    const measured = 255 * lut[Math.round(x / 255 * (lut.length - 1))];
    return channel ? x + clamp(measured - x, -18, 18) : x + (measured - x) * 0.85;
  });
  if (channel) { values[0] = 0; values[8] = 255; }
  else { values[0] = clamp(values[0], 0, 40); values[8] = clamp(values[8], 185, 255); }
  for (let i = 0; i < xs.length; i++) values[i] = clamp(values[i], 0.3 * xs[i], 255 - 0.3 * (255 - xs[i]));
  // Keep the fitted treatment smooth between all anchors instead of reproducing histogram
  // plateaus and steep scene-specific steps from one demonstration image.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < xs.length; i++) values[i] = clamp(values[i], values[i - 1] + (xs[i] - xs[i - 1]) * 0.3, Math.min(255 - 0.3 * (255 - xs[i]), values[i - 1] + (xs[i] - xs[i - 1]) * 1.8));
    for (let i = xs.length - 2; i >= 0; i--) values[i] = clamp(values[i], Math.max(0, values[i + 1] - (xs[i + 1] - xs[i]) * 1.8), values[i + 1] - (xs[i + 1] - xs[i]) * 0.3);
  }
  return xs.map((x, i) => [x, values[i]]);
}
function scaleLookParams(params, amount) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) out[key] = value.map(([x, y]) => [x, x + (y - x) * amount]);
    else if (typeof value === 'number') {
      if (key === 'curveSaturation') out[key] = 100 + (value - 100) * amount;
      else if (key.startsWith('hue_')) { const d = ((value + 180) % 360 + 360) % 360 - 180; out[key] = d * amount; }
      else if (SLIDERS.find(s => s.key === key)?.hue) out[key] = value;
      else out[key] = value * amount;
    } else out[key] = value;
  }
  return out;
}

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
function applyDelta(base, delta) {
  if (!base || !delta) return null;
  const out = clone(base);
  for (const [k, v] of Object.entries(delta)) if (typeof v === 'number' && Number.isFinite(out[k])) out[k] += v;
  return out;
}
function skinDelta(before, after) {
  if (!before || !after) return null;
  const sub = (a, b) => {
    if (!a || !b) return null;
    const d = {};
    for (const k of ['L', 'a', 'b']) if (Number.isFinite(a[k]) && Number.isFinite(b[k])) d[k] = a[k] - b[k];
    return d;
  };
  const out = { ...sub(after, before) };
  if (before.version === 2 && after.version === 2) {
    out.version = 2;
    // Store one reusable profile delta. Runtime people IDs belong to the current image and
    // cannot be paired with identities from the catalogue source photo.
    const zones = {};
    for (const name of ['shadow', 'midtone', 'lit']) {
      const deltas = [];
      for (const person of after.people) {
        const old = before.people.find((q) => q.id === person.id), d = sub(person.zones?.[name], old?.zones?.[name]);
        if (d) deltas.push(d);
      }
      if (deltas.length) zones[name] = Object.fromEntries(['L', 'a', 'b'].map((k) => [k, deltas.reduce((sum, d) => sum + (d[k] || 0), 0) / deltas.length]));
    }
    out.people = [{ id: 'adaptive-profile', zones }];
  }
  return out;
}
function skinTarget(base, delta) {
  if (!base || !delta) return null;
  if (!Array.isArray(base.people)) return applyDelta(base, delta);
  const out = clone(base);
  for (const k of ['L', 'a', 'b']) if (Number.isFinite(out[k]) && Number.isFinite(delta[k])) out[k] += delta[k];
  const profileZones = delta.version === 2 ? delta.people?.[0]?.zones : null;
  for (const p of out.people || []) {
    const dZones = profileZones || delta.people?.find((x) => x.id === p.id)?.zones;
    for (const [name, z] of Object.entries(p.zones || {})) {
      const dz = dZones?.[name] || (delta.version !== 2 ? delta : null);
      if (dz) for (const k of ['L', 'a', 'b']) if (Number.isFinite(z[k]) && Number.isFinite(dz[k])) z[k] += dz[k];
    }
  }
  return out;
}

function fitPerPerson(ps, cur, sourceStats, targetStats, move) {
  if (sourceStats?.version !== 2 || targetStats?.version !== 2 || !sourceStats.people?.length || sourceStats.people.length !== targetStats.people?.length) {
    return fitSkinMatch(ps, cur, targetStats, { move });
  }
  const people = [];
  for (const source of sourceStats.people) {
    const target = targetStats.people.find((p) => p.id === source.id);
    if (!target) continue;
    // Without positions, the skin matcher cannot pair a multi-person reference. Fit each
    // person against their own current stats plus the generic profile delta instead.
    const labels = new Uint8Array(ps.n);
    for (let i = 0; i < ps.n; i++) if (ps.skinPeople?.[i] === source.id) labels[i] = source.id;
    const personPs = { ...ps, skinPeople: labels };
    const match = fitSkinMatch(personPs, cur, { version: 2, people: [{ ...target, id: 'adaptive-profile' }] }, { move });
    if (match?.people?.length) people.push(...match.people);
  }
  return { version: 2, people, targets: people.map((p) => ({ id: p.id, referenceId: p.referenceId, zones: p.zones.map((z) => z.name) })) };
}

function fitAdaptiveBackground(ps, params, look, amount, limits) {
  if (!ps.subject) return { params, regions: null, warning: 'Background mask unavailable; adaptive background fitting was skipped.' };
  const sampled = [], step = Math.max(1, Math.floor(ps.n / 6000));
  for (let i = 0; i < ps.n; i += step) if (ps.subject[i] < 64) sampled.push(i);
  const idx = Int32Array.from(sampled);
  if (idx.length < 20) return { params, regions: null, warning: 'Background mask has too few pixels for adaptive fitting.' };
  const delta = look.targets?.background, own = measure(ps, ps, idx);
  if (!delta || !own?.tone?.pct) return { params, regions: null, warning: 'Reference background measurements are unavailable.' };
  const target = {
    mid: clamp(own.tone.pct[50] + amount * (delta.tone?.pct?.[50] || 0), 0, 100),
    a: own.wb.a + amount * (delta.wb?.a || 0), b: own.wb.b + amount * (delta.wb?.b || 0),
    chroma: own.color.meanChroma + amount * (delta.color?.meanChroma || 0),
    wbSupported: (own.wb.pixels || 0) >= 0.02,
  };
  const max = [limits.backgroundExposure ?? 0.25, limits.backgroundTemp ?? 10, limits.backgroundTint ?? 10, limits.backgroundSaturation ?? 20].map(v => v * amount);
  const base = { ...params }; delete base.local;
  const cur = pixelBuffers(ps.n);
  const evaluate = (x) => {
    const local = { background: { exposure: x[0], temp: x[1], tint: x[2], saturation: x[3] } };
    processPixelSet(ps, { ...base, local }, idx, cur);
    const stats = measure(ps, cur, idx), residual = [(stats.tone.pct[50] - target.mid) / 2];
    if (target.wbSupported) residual.push((stats.wb.a - target.a) / 2, (stats.wb.b - target.b) / 2);
    residual.push((stats.color.meanChroma - target.chroma) / 2, x[0] / 0.18, x[1] / 7, x[2] / 7, x[3] / 14);
    return { residual, stats, local };
  };
  const fitted = lm((x) => evaluate(x).residual, [0, 0, 0, 0], max.map((v) => -v), max, { iters: 12 });
  const result = evaluate(fitted.x), background = Object.fromEntries(Object.entries(result.local.background).map(([k, v]) => [k, k === 'exposure' ? Math.round(v * 100) / 100 : Math.round(v)]));
  return { params: { ...base, local: { background } }, regions: { background: { target, after: result.stats, local: background } }, warning: null };
}

/** Build a versioned profile from paired images from the same scene. */
export function buildAdaptiveLook(beforePs, afterPs, { id, name, thumb = null, beforeThumb = null, source = null } = {}) {
  const before = measure(beforePs), after = measure(afterPs);
  const fitted = solve(beforePs, before, after, { strength: 1 });
  const params = clone(fitted.params);
  // The core solver wraps hue sliders into 0..360 when clamping, while the render pipeline
  // interprets these controls as signed offsets in -100..100. Restore the equivalent short offset.
  for (const key of Object.keys(params)) if (key.startsWith('hue_') && Number.isFinite(params[key])) params[key] = ((params[key] + 180) % 360 + 360) % 360 - 180;
  for (const key of ['curve', 'curveR', 'curveG', 'curveB']) params[key] = smoothLookCurve(params[key], key !== 'curve');
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
    reference: { before, after, skinBefore: beforeSkin, skinAfter: afterSkin,
      backgroundBefore: regionStats(beforePs, beforePs, false), backgroundAfter: regionStats(afterPs, afterPs, false) },
    targets: {
      skin: skinMaskAvailable ? skinDelta(beforeSkin, afterSkin) : null,
      background: deltaStats(bgAfter, bgBefore),
      subject: deltaStats(subAfter, subBefore),
    },
    limits: { transform: transformLimits, curveSlope: [0.3, 1.8], normaliseExposure: 0.75, normaliseTemp: 30, normaliseTint: 25, exposure: [-3, 3], temp: [-100, 100], tint: [-100, 100], backgroundExposure: 0.25, backgroundTemp: 10, backgroundTint: 10, backgroundSaturation: 20, maxGuardScale: 1, skinDeltaL: 8, skinDeltaAB: 3 },
    metadata: { skinMaskAvailable, sourceMaskMethod: beforePs.subject ? 'subject-mask' : 'color-window' },
  };
}

/** Solve this profile for a particular PixelSet. Amount zero is a strict identity operation. */
export function solveAdaptiveLook(ps, look, { strength = 1, skinProtection = 1, scene = null } = {}) {
  const amount = clamp(Number.isFinite(strength) ? strength : 1, 0, 1);
  const protection = clamp(Number.isFinite(skinProtection) ? skinProtection : 1, 0, 1);
  if (amount === 0) return {
    params: {}, targets: null, normalise: { exposure: 0, temp: 0, tint: 0 }, timings: { total: 0, evals: 0 }, guardScale: 1,
    adaptive: { id: look.id, skinProtected: false, maskAvailable: Boolean(ps.skinMask), limits: clone(look.limits), warning: null },
  };
  const own = measure(ps);
  const limits = look.limits || { normaliseExposure: 0.75, normaliseTemp: 30, normaliseTint: 25, maxGuardScale: 1, skinDeltaL: 8, skinDeltaAB: 12 };
  const scaledLook = scaleLookParams(look.params, amount);
  const normalized = solvePreset(ps, own, scaledLook, { strength: 1, scene, pull: 0.35 });
  const normalise = {
    exposure: clamp(normalized.normalise.exposure * amount, -limits.normaliseExposure, limits.normaliseExposure),
    temp: clamp(normalized.normalise.temp * amount, -limits.normaliseTemp, limits.normaliseTemp),
    tint: clamp(normalized.normalise.tint * amount, -limits.normaliseTint, limits.normaliseTint),
  };
  let params = { ...normalized.params,
    exposure: (scaledLook.exposure || 0) + normalise.exposure,
    temp: (scaledLook.temp || 0) + normalise.temp,
    tint: (scaledLook.tint || 0) + normalise.tint,
    curveSaturation: scaledLook.curveSaturation ?? 100,
  };
  for (const slider of SLIDERS) if (Number.isFinite(params[slider.key])) params[slider.key] = clamp(params[slider.key], ...slider.ui);
  const background = fitAdaptiveBackground(ps, params, look, amount, limits);
  params = background.params;
  const cur = pixelBuffers(ps.n);
  processPixelSet(ps, params, null, cur);
  const currentSkin = skinStats(ps);
  let skinMatch = null;
  if (protection > 0 && currentSkin && look.targets?.skin) {
    const d = clone(look.targets.skin);
    for (const p of d.people || []) for (const z of Object.values(p.zones || {})) {
      if (Number.isFinite(z.L)) z.L = clamp(z.L * amount, -limits.skinDeltaL, limits.skinDeltaL);
      for (const k of ['a', 'b']) if (Number.isFinite(z[k])) z[k] = clamp(z[k] * amount, -limits.skinDeltaAB, limits.skinDeltaAB);
    }
    for (const k of ['L', 'a', 'b']) if (Number.isFinite(d[k])) d[k] = clamp(d[k] * amount, k === 'L' ? -limits.skinDeltaL : -limits.skinDeltaAB, k === 'L' ? limits.skinDeltaL : limits.skinDeltaAB);
    const target = skinTarget(currentSkin, d);
    skinMatch = fitPerPerson(ps, cur, currentSkin, target, protection);
    if (skinMatch) params.skinMatch = skinMatch;
  }
  return {
    params, targets: { skin: look.targets?.skin || null, background: look.targets?.background || null }, normalise, regions: background.regions,
    timings: normalized.timings, guardScale: 1,
    adaptive: { id: look.id, skinProtected: Boolean(skinMatch?.people?.length || skinMatch?.deltaA || skinMatch?.deltaB || skinMatch?.deltaL), maskAvailable: Boolean(ps.skinMask && currentSkin), backgroundFitted: !!background.regions,
      limits: clone(limits), warning: [background.warning, ps.skinMask ? (currentSkin ? null : 'Skin mask has too few confident pixels for correction.') : 'Skin mask unavailable; skin protection was skipped.'].filter(Boolean).join(' ') || null },
  };
}
