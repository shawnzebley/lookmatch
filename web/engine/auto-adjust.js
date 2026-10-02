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

// ---- fade, point colour and HSL for the look Auto Adjust aims at: a clean, natural portrait with a soft
// matte floor. Fade is sized from the measured clipping so it also keeps the photo from blowing or crushing.
// tone: { clipLo, clipHi, p5, p99 } (fractions, and L* percentiles)
export function fadeFor(tone = {}) {
  const lo = tone.clipLo > 0.002 ? 9 : tone.p5 < 4 ? 6 : 4;
  const hi = tone.clipHi > 0.002 ? 6 : tone.p99 > 97 ? 4 : 2;
  return { fadeBlacks: lo, fadeWhites: hi };
}

// Colour-picker moves. Skin: nudge hue toward natural, chroma into a healthy range, lift a dark face.
export function skinPoint(L, a, b) {
  const C = Math.hypot(a, b);
  if (!Number.isFinite(C) || C < 4) return null;
  const h = Math.atan2(b, a) * 180 / Math.PI;
  const hue = Math.round(clamp((53 - h) / 30 * 100, -15, 15));
  const sat = C < 18 ? 8 : C > 32 ? -8 : 0;
  const lum = L < 55 ? 6 : L > 80 ? -4 : 0;
  if (!hue && !sat && !lum) return null;
  return { L, a, b, hue, sat, lum, range: 35, auto: true };
}

// Look targets per colour band (outside skin hues, which the skin point owns): foliage tamed, blues deepened.
const BAND_LOOK = {
  green: { sat: -10, lum: -4 },
  aqua: { sat: -4, lum: -4 },
  blue: { sat: 8, lum: -6 },
  purple: { sat: -6, lum: 0 },
  magenta: { sat: -6, lum: 0 },
};
// bands: measure().bands. The most prominent look colour gets a picked point, the other present bands get HSL.
export function lookColor(bands = {}, minWeight = 0.03) {
  const present = Object.keys(BAND_LOOK).filter((k) => (bands[k]?.weight || 0) >= minWeight && (bands[k]?.chroma || 0) > 8);
  if (!present.length) return { point: null, hsl: {} };
  const top = present.reduce((m, k) => (bands[k].weight * bands[k].chroma > bands[m].weight * bands[m].chroma ? k : m));
  const bd = bands[top], rad = bd.hue * Math.PI / 180, t = BAND_LOOK[top];
  const point = { L: bd.lum, a: bd.chroma * Math.cos(rad), b: bd.chroma * Math.sin(rad), hue: 0, sat: t.sat, lum: t.lum, range: 40, auto: true };
  const hsl = {};
  for (const k of present) if (k !== top) { hsl[`sat_${k}`] = BAND_LOOK[k].sat; hsl[`lum_${k}`] = BAND_LOOK[k].lum; }
  return { point, hsl };
}
