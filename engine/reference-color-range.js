import { colorRangeWeight } from './color-range.js';

const cache = new WeakMap();

// Sampled source-space HSL colors establish support, never scene-wide average color.
// Old references lack these samples and cannot authorize a range-specific match.
export function referenceRangeSupport(selection, samples) {
  if (!selection || !Array.isArray(samples) || samples.length < 20) {
    return { available: false, supported: false, fraction: 0, weight: 0 };
  }
  const key = JSON.stringify(selection), previous = cache.get(samples);
  if (previous?.key === key) return previous.result;
  let count = 0, valid = 0;
  for (const sample of samples) {
    if (!Array.isArray(sample) || sample.length !== 3 || !sample.every(Number.isFinite)) continue;
    valid++;
    count += colorRangeWeight({ h: sample[0], s: sample[1], l: sample[2] }, selection);
  }
  const fraction = valid ? count / valid : 0;
  const supported = count >= 20 && fraction >= 0.015;
  const result = { available: valid >= 20, supported, fraction,
    weight: supported ? Math.min(1, fraction / 0.03) : 0 };
  cache.set(samples, { key, result });
  return result;
}
