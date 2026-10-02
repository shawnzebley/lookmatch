// Keep reference-matched tonal targets intact when Auto Adjust is requested.
export function hasReferenceCurve(params = {}) {
  return params.curveAuto === 'reference' ||
    ['subject', 'background'].some((region) => params.local?.[region]?.curveAuto === 'reference');
}

export function autoAdjustResult(params = {}, calculated = {}) {
  return hasReferenceCurve(params)
    ? { ...params, preservedReference: true }
    : { ...calculated, preservedReference: false };
}

// Portrait rules for Auto Adjust, taken from a working portrait editor's Lightroom routine. Each is
// small on purpose: Auto Adjust is a starting correction, not a look.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SKIN_HUE = [44, 64]; // Lab hue angle (deg) where skin reads as natural

// White balance judged on skin: skin that leans green or yellow gets magenta (tint up) and a touch of
// blue (temp down), moving opposite the colour to remove. Skin that leans red/magenta gets the reverse,
// more gently. Returns slider deltas, capped so it stays a "teeny tiny bit".
export function skinWhiteBalance(meanA, meanB) {
  if (!Number.isFinite(meanA) || !Number.isFinite(meanB) || Math.hypot(meanA, meanB) < 4) return { temp: 0, tint: 0 };
  const hue = Math.atan2(meanB, meanA) * 180 / Math.PI;
  if (hue > SKIN_HUE[1]) {
    const e = hue - SKIN_HUE[1];
    return { temp: -Math.round(clamp(e * 0.35, 0, 4)), tint: Math.round(clamp(e * 0.6, 0, 6)) };
  }
  if (hue < SKIN_HUE[0]) {
    const e = SKIN_HUE[0] - hue;
    return { temp: 0, tint: -Math.round(clamp(e * 0.3, 0, 3)) };
  }
  return { temp: 0, tint: 0 };
}

// Saturation slightly down, vibrance up: keeps skin natural while muted colours get some pop. Photos
// that are already vivid (high mean chroma) get less vibrance.
export function presenceFor(meanChroma) {
  const c = Number.isFinite(meanChroma) ? meanChroma : 20;
  return { saturation: -4, vibrance: Math.round(clamp(40 - c, 8, 28)) };
}

// Pull the highlights down on the tone curve before raising exposure, so lifting a dark photo doesn't
// blow the top end: how many curve units to drop the upper-middle by, for an exposure lift.
export function highlightRollOff(exposure) {
  return exposure > 0.08 ? Math.round(clamp(exposure * 22, 0, 12)) : 0;
}
