// Adaptive references keep regional lighting and non-skin palette measurements separate.
import { referenceTransferStats, fitReferenceTransfer } from './reference-transfer.js';
import { BANDS, REGION_IN, REGION_OUT, measure, regionStats } from './measure.js';
import { defaultParams, processPixelSet } from './pipeline.js';
import { computeTargets } from './solver.js';

const REGIONS = ['subject', 'background'];

function masks(ps, region = null) {
  const full = new Uint8Array(ps.n), palette = new Uint8Array(ps.n);
  for (let i = 0; i < ps.n; i++) {
    const inside = region === 'subject' ? ps.subject?.[i] >= REGION_IN
      : region === 'background' ? ps.subject?.[i] < REGION_OUT : true;
    if (!inside) continue;
    full[i] = 255;
    const skin = ps.skinMask ? ps.skinMask[i] >= 64 : Boolean(ps.masks?.skin?.[i]);
    if (!skin && ps.L[i] > 8 && ps.L[i] < 90) palette[i] = 255;
  }
  return { full, palette };
}

function regionTargets(ps, region) {
  const mask = masks(ps, region);
  const full = referenceTransferStats(ps, { mask: mask.full });
  if (!full) return null;
  const palette = referenceTransferStats(ps, { mask: mask.palette });
  const paletteSupported = (palette?.n || 0) >= Math.max(100, full.n * 0.05);
  const color = paletteSupported ? palette : { mean: [0, 0], std: [1, 1], hueSectors: [] };
  return { ...full, mean: color.mean, std: color.std, hueSectors: color.hueSectors,
    paletteN: palette?.n || 0, paletteSupported };
}

function fitPalette(source, target, strength) {
  const colorTarget = source.paletteSupported && target.paletteSupported ? target
    : { ...target, mean: source.mean, std: source.std, hueSectors: [] };
  const colorSource = source.paletteSupported && target.paletteSupported ? source
    : { ...source, hueSectors: [] };
  const transfer = fitReferenceTransfer(colorSource, colorTarget, { strength, preserveColors: true });
  if (!transfer || transfer.identity) return transfer;
  transfer.chromaFade = [4, 12];
  return transfer;
}

function bandCorrections(ps, rendered, targetStats, strength, region) {
  if (!targetStats?.bandsAdaptive) return [];
  const indices = regionIndices(ps, region);
  const before = measure(ps, ps, indices), predicted = measure(ps, rendered, indices);
  const aims = computeTargets(before, targetStats, { strength, adaptive: true }).bands;
  const corrections = [];
  for (const name of BANDS) {
    const aim = aims[name], source = before.bandsAdaptive[name];
    const reference = targetStats.bandsAdaptive[name], have = predicted.bandsAdaptive[name];
    // Only correspond a measured RGB hue band when both images have meaningful,
    // chromatic support. This avoids treating a missing hue as neutral evidence.
    if (!aim || !source || !reference || !have || source.weight < 0.015 || reference.weight < 0.015 ||
        source.chroma < 5 || reference.chroma < 5 || have.weight < 0.015) continue;
    const hueDelta = Math.max(-25, Math.min(25, ((aim.hue - source.hue + 540) % 360) - 180));
    const ratio = aim.chroma / Math.max(1e-6, source.chroma);
    const chroma = source.chroma * Math.max(0.7, Math.min(1.3, ratio));
    const targetRadians = (source.hue + hueDelta) * Math.PI / 180;
    const haveRadians = have.hue * Math.PI / 180;
    const desiredAB = [Math.cos(targetRadians) * chroma, Math.sin(targetRadians) * chroma];
    const predictedAB = [Math.cos(haveRadians) * have.chroma, Math.sin(haveRadians) * have.chroma];
    if (![...desiredAB, ...predictedAB].every(Number.isFinite)) continue;
    corrections.push({ center: (source.hue + 360) % 360, width: 32, weight: 1,
      deltaA: desiredAB[0] - predictedAB[0], deltaB: desiredAB[1] - predictedAB[1] });
  }
  return corrections;
}

function regionIndices(ps, region) {
  if (!region) return null;
  return Int32Array.from(Array.from({ length: ps.n }, (_, i) => i)
    .filter((i) => region === 'subject' ? ps.subject[i] >= REGION_IN : ps.subject[i] < REGION_OUT));
}

export function adaptiveReferenceTargets(ps) {
  if (!ps?.n || !ps.lr || !ps.L) return null;
  const all = regionTargets(ps, null);
  if (!all) return null;
  const subject = ps.subject ? regionTargets(ps, 'subject') : null;
  const background = ps.subject ? regionTargets(ps, 'background') : null;
  return { version: 1, all, subject, background };
}

export function solveAdaptiveTransfer(ps, reference, strength = 1, split = true) {
  const target = reference?.adaptiveTransfer;
  if (target?.version !== 1) return null;
  const started = performance.now();
  const source = adaptiveReferenceTargets(ps);
  if (!source) return null;
  const params = defaultParams();
  const canSplit = split && ps.subject && REGIONS.every((name) => source[name]?.n >= 200 && target[name]?.n >= 200);
  const scopes = canSplit ? REGIONS : ['all'];
  if (canSplit) {
    params.local = Object.fromEntries(REGIONS.map((name) => [name, {
      referenceTransfer: fitPalette(source[name], target[name], strength), curveAuto: 'reference',
    }]));
    if (REGIONS.some((name) => !params.local[name].referenceTransfer)) return null;
  } else {
    params.referenceTransfer = fitPalette(source.all, target.all, strength);
    if (!params.referenceTransfer) return null;
  }
  params.referenceMethod = 'lab-distribution';
  params.curveAuto = 'reference';
  if (source.all.paletteSupported && target.all.paletteSupported) {
    const rendered = processPixelSet(ps, params);
    for (const name of scopes) {
      if (!source[name].paletteSupported || !target[name].paletteSupported) continue;
      const transfer = canSplit ? params.local[name].referenceTransfer : params.referenceTransfer;
      const targetStats = canSplit ? reference.maskedRegions?.[name] : reference;
      transfer.bandCorrections = bandCorrections(ps, rendered, targetStats, strength, canSplit ? name : null);
    }
  }
  const before = canSplit ? regionStats(ps) : null;
  const after = canSplit ? regionStats(ps, processPixelSet(ps, params)) : null;
  const relation = (s) => ({ sep: s.sep, dA: s.dA, dB: s.dB, chroma: Math.exp(s.logC) });
  return {
    params,
    targets: computeTargets(measure(ps), reference, { strength, adaptive: true }),
    regions: canSplit ? { from: { kind: 'reference' }, frac: before.frac, before: relation(before), after: relation(after),
      target: relation(reference.regions || before), theirs: relation(reference.regions || before), local: params.local,
      referenceStyle: { regionCurves: false, labTransfer: true, backgroundHslBands: [] } } : null,
    warning: scopes.some((name) => !source[name].paletteSupported || !target[name].paletteSupported)
      ? 'Non-skin palette support is too small; matched lighting only in the affected region.' : null,
    timings: { total: performance.now() - started }, guardScale: 1,
  };
}
