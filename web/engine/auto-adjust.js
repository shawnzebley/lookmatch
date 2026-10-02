// Auto Adjust chases the chosen look itself (fade, curves, picked colours, HSL), so a reference match is
// recalculated rather than preserved; Re-match brings the solver's version back.
export function autoAdjustResult(params = {}, calculated = {}) {
  return { ...calculated, preservedReference: false };
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

// Colour contrast on the grading wheels: warm highlights against cool shadows (complementary colours
// read as extra contrast without touching exposure). Wheels, not RGB curves, because a wheel moves colour
// only. It fills the gap between the two zones' blue-yellow balance up to GRADE_SEP Lab b* units, split
// between them, and does nothing once the photo already has that much separation or a zone is nearly empty.
// Rendered through the pipeline on a neutral ramp, one wheel unit moves a zone's b* by about 0.21.
// zones: measure().zones ({ shadows, highlights }: b, mass)
const GRADE_SEP = 4, GRADE_HUE = { shadow: 225, highlight: 40 }, GRADE_SHARE = { shadow: 0.6, highlight: 0.4 };
const GRADE_PER_B = 4.7, GRADE_MAX = { shadow: 12, highlight: 8 };
export function colorContrast(zones = {}) {
  const s = zones.shadows, h = zones.highlights;
  if (!s || !h || !(s.mass >= 0.02) || !(h.mass >= 0.02) || !Number.isFinite(s.b) || !Number.isFinite(h.b)) return {};
  const gap = GRADE_SEP - (h.b - s.b);
  if (gap < 0.5) return {};
  const sat = (z) => Math.round(clamp(gap * GRADE_SHARE[z] * GRADE_PER_B, 0, GRADE_MAX[z]));
  return { shadowHue: GRADE_HUE.shadow, shadowSat: sat('shadow'), highlightHue: GRADE_HUE.highlight, highlightSat: sat('highlight') };
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

// ---- chasing a chosen look. own = the photo as it stands, target = what the look measures (a reference's
// stats, or a photographer's nearest published scenes). Every move is capped so one click never overshoots.
const angDiff = (t, o) => ((t - o + 540) % 360) - 180;
const near0 = (...v) => v.every((x) => Math.abs(x) < 3);

// Fade only toward the look's black and white ends (a matte look lifts the floor, a soft one drops the top),
// never below what keeps the photo from clipping.
// own: { p1, p99, clipLo, clipHi } (L* percentiles, clip fractions); target: { p1, p99 }
export function lookFade(own, target) {
  if (!target || target.p1 == null || target.p99 == null) return null;
  return {
    fadeBlacks: Math.max(Math.round(clamp((target.p1 - own.p1) / 0.25, 0, 60)), own.clipLo > 0.002 ? 6 : 0),
    fadeWhites: Math.max(Math.round(clamp((own.p99 - target.p99) / 0.25, 0, 60)), own.clipHi > 0.002 ? 4 : 0),
  };
}

// Skin point: own skin { L, a, b } toward the look's skin { hue, chroma } (Lab hue degrees).
export function lookSkinPoint(own, target) {
  const C = Math.hypot(own.a, own.b);
  if (!target || !Number.isFinite(target.hue) || !Number.isFinite(target.chroma) || !(C >= 4)) return null;
  const h = Math.atan2(own.b, own.a) * 180 / Math.PI;
  const hue = Math.round(clamp(angDiff(target.hue, h) / 30 * 100, -35, 35));
  const sat = Math.round(clamp((target.chroma / C - 1) * 100, -30, 30));
  const lum = own.L < 55 ? 6 : own.L > 80 ? -4 : 0;
  if (near0(hue, sat, lum)) return null;
  return { L: own.L, a: own.a, b: own.b, hue, sat, lum, range: 35, auto: true };
}

// Colour bands toward the look's (hue, saturation, luminance of each band). Skin hues (red, orange) are left
// to the skin point. The band that has to move most gets a picked point; the others get HSL deltas.
export function lookBands(own = {}, target = {}) {
  const moves = [];
  for (const k of ['yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']) {
    const o = own[k], t = target[k];
    if (!o || !t || !(o.weight >= 0.02) || !(o.chroma > 8) || !(t.weight >= 0.01) || !(t.chroma > 5)) continue;
    const sat = Math.round(clamp((t.chroma / o.chroma - 1) * 70, -35, 35));
    const hue = Math.round(clamp(angDiff(t.hue, o.hue) / 30 * 100, -40, 40));
    const lum = Math.round(clamp(((t.lumRel || 0) - (o.lumRel || 0)) * 1.2, -20, 20));
    if (near0(sat, hue, lum)) continue;
    moves.push({ k, o, sat, hue, lum, score: o.weight * (Math.abs(sat) + Math.abs(hue) * 0.5 + Math.abs(lum)) });
  }
  if (!moves.length) return { point: null, hsl: {} };
  const top = moves.reduce((m, v) => (v.score > m.score ? v : m));
  const rad = top.o.hue * Math.PI / 180;
  const point = { L: top.o.lum, a: top.o.chroma * Math.cos(rad), b: top.o.chroma * Math.sin(rad), hue: top.hue, sat: top.sat, lum: top.lum, range: 40, auto: true };
  const hsl = {};
  for (const m of moves) if (m !== top) { hsl[`hue_${m.k}`] = m.hue; hsl[`sat_${m.k}`] = m.sat; hsl[`lum_${m.k}`] = m.lum; }
  return { point, hsl };
}

// Overall colour intensity toward the look's mean chroma.
export function lookPresence(ownChroma, targetChroma) {
  if (!(ownChroma > 1) || !(targetChroma > 0)) return null;
  const r = clamp(targetChroma / ownChroma, 0.5, 1.6);
  return { saturation: Math.round(clamp((r - 1) * 30, -25, 10)), vibrance: Math.round(clamp((r - 1) * 50, -25, 35)) };
}
