// Fit reference curves on isolated subject/background pixels before those corrections are
// attached to the normal whole-image result.
import { measure, regionStats } from './measure.js';
import { computeTargets, solve } from './solver.js';
import { defaultParams, LOCAL_SLIDERS, LOCAL_WHEEL_KEYS, processPixelSet } from './pipeline.js';

const REGIONS = ['subject', 'background'];
const CORE_IN = 191;
const CORE_OUT = 64;

function regionSubset(ps, region) {
  const m = ps?.masks;
  if (!ps || !m || !ps.subject || !m.zone || !m.zoneTint || !m.neutral || !m.lowSat || !m.skin || !m.bw || !m.zw) return null;
  const mask = new Uint8Array(ps.n);
  let count = 0;
  for (let i = 0; i < ps.n; i++) {
    const v = ps.subject[i];
    if ((region === 'subject' && v >= CORE_IN) || (region === 'background' && v < CORE_OUT)) {
      mask[i] = 255;
      count++;
    }
  }
  if (count < 200) return null;

  const indices = new Uint32Array(count);
  for (let i = 0, k = 0; i < ps.n; i++) if (mask[i]) indices[k++] = i;
  const planes = {};
  for (const key of ['lr', 'lg', 'lb', 'L', 'A', 'B', 'hue']) {
    if (!ps[key]) return null;
    const src = ps[key], dst = new src.constructor(count);
    for (let k = 0; k < count; k++) dst[k] = src[indices[k]];
    planes[key] = dst;
  }
  const masks = {};
  for (const key of ['zone', 'zoneTint', 'neutral', 'lowSat', 'skin']) {
    const src = m[key], dst = new src.constructor(count);
    for (let k = 0; k < count; k++) dst[k] = src[indices[k]];
    masks[key] = dst;
  }
  masks.bw = new m.bw.constructor(count * 8);
  masks.zw = new m.zw.constructor(count * 3);
  for (let k = 0; k < count; k++) {
    const i = indices[k];
    for (let q = 0; q < 8; q++) masks.bw[k * 8 + q] = m.bw[i * 8 + q];
    for (let q = 0; q < 3; q++) masks.zw[k * 3 + q] = m.zw[i * 3 + q];
  }
  masks.regionTint = null;
  const skinMask = ps.skinMask ? new ps.skinMask.constructor(count) : undefined;
  if (skinMask) for (let k = 0; k < count; k++) skinMask[k] = ps.skinMask[indices[k]];
  return {
    ...planes,
    n: count,
    width: count,
    height: 1,
    subject: null,
    masks,
    skinMask,
    skinSource: ps.skinSource,
    faceCount: ps.faceCount,
    wbConfidence: Math.max(0.05, Math.min(1, masks.neutral.reduce((a, v) => a + (v ? 1 : 0), 0) / (0.03 * count))),
  };
}

function validStats(s) {
  return s && s.tone?.pct && s.wb && s.zones && s.bands && s.color && s.skin;
}

/** Measure the reference's isolated core subject/background regions, when sufficiently supported. */
export function referenceRegionTargets(ps) {
  const frac = ps?.n && ps.subject
    ? Array.from(ps.subject).reduce((sum, v) => sum + v, 0) / (255 * ps.n)
    : 0;
  if (!(frac >= 0.03 && frac <= 0.92)) return null;
  const subject = regionSubset(ps, 'subject'), background = regionSubset(ps, 'background');
  if (!subject || !background) return null;
  return { version: 1, subject: measure(subject), background: measure(background) };
}

function regionalParams(params) {
  const out = {};
  for (const { key } of LOCAL_SLIDERS) out[key] = params[key] || 0;
  for (const key of LOCAL_WHEEL_KEYS) out[key] = params[key] || 0;
  for (const key of ['curve', 'curveR', 'curveG', 'curveB']) if (params[key]) out[key] = params[key];
  out.curveAmount = 100;
  out.curveAuto = 'reference';
  return out;
}

/** Solve each source core directly against its matching reference core. */
export function solveMaskedReference(ps, refStats, opts = {}) {
  const targets = refStats?.maskedRegions;
  if (targets?.version !== 1 || !REGIONS.every((r) => validStats(targets[r]))) return null;
  const fraction = ps?.subject && ps.n ? ps.subject.reduce((sum, v) => sum + v, 0) / (255 * ps.n) : 0;
  if (fraction < 0.03 || fraction > 0.92) return null;
  const src = Object.fromEntries(REGIONS.map((r) => [r, regionSubset(ps, r)]));
  if (!REGIONS.every((r) => src[r])) return null;

  const started = performance.now();
  const fitted = {};
  for (const region of REGIONS) {
    const sourceStats = measure(src[region]);
    fitted[region] = solve(src[region], sourceStats, targets[region], { ...opts, scene: opts.scene });
    if (!fitted[region]?.params) return null;
  }
  const baseTargets = computeTargets(measure(ps), refStats, opts);
  const params = {
    ...defaultParams(),
    curveAuto: 'reference',
    saturation: 0,
    temp: 0,
    local: {
      subject: regionalParams(fitted.subject.params),
      background: regionalParams(fitted.background.params),
    },
  };
  const before = regionStats(ps), after = regionStats(ps, processPixelSet(ps, params));
  const reference = refStats.regions || before;
  const relations = (s) => ({ sep: s.sep, dA: s.dA, dB: s.dB, chroma: Math.exp(s.logC) });
  return {
    params,
    targets: baseTargets,
    regionalTargets: { subject: targets.subject, background: targets.background },
    guardScale: Math.min(fitted.subject.guardScale ?? 1, fitted.background.guardScale ?? 1),
    timings: {
      total: performance.now() - started,
      regions: { subject: fitted.subject.timings, background: fitted.background.timings },
    },
    regions: { frac: before.frac, before: relations(before), after: relations(after), target: relations(reference),
      theirs: relations(reference), local: params.local, from: { kind: 'reference' },
      referenceStyle: { regionCurves: true, subjectCurve: !!params.local.subject.curve, backgroundHslBands: [] } },
  };
}
