// Auto Adjust chases the chosen look itself (fade, curves, picked colours, HSL), so a reference match is
// recalculated rather than preserved; Re-match brings the solver's version back.
export function autoAdjustResult(params = {}, calculated = {}) {
  return { ...calculated, preservedReference: false };
}

// Portrait rules for Auto Adjust, taken from a working portrait editor's Lightroom routine. Each is
// small on purpose: Auto Adjust is a starting correction, not a look.
import { labToLin, linearToSrgb } from './color.js';
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

// Skin point (the colour eyedropper on the face): own skin { L, a, b } onto the look's skin { hue, chroma, lum }
// (Lab hue degrees, lum optional: older saved references don't carry it). Capped so one click never overshoots.
export function lookSkinPoint(own, target) {
  const C = Math.hypot(own.a, own.b);
  if (!target || !Number.isFinite(target.hue) || !Number.isFinite(target.chroma) || !(C >= 4)) return null;
  const h = Math.atan2(own.b, own.a) * 180 / Math.PI;
  const hue = Math.round(clamp(angDiff(target.hue, h) / 30 * 100, -100, 100));
  const sat = Math.round(clamp((target.chroma / C - 1) * 100, -100, 100));
  // luminance slider: +-100 is +-20 L*, so close most of the gap to the look's skin brightness
  const lum = Number.isFinite(target.lum) && target.lum > 10 ? Math.round(clamp((target.lum - own.L) * 5, -100, 100)) : own.L < 55 ? 6 : own.L > 80 ? -4 : 0;
  if (near0(hue, sat, lum)) return null;
  return { L: own.L, a: own.a, b: own.b, hue, sat, lum, range: 35, auto: true };
}

// Background colours onto the look's, one HSL slider triple per colour band (hue, saturation, luminance).
// Pass bands measured without skin pixels (measure().bandsBg). Red and orange are skipped when the photo has
// skin, because the skin point owns those hues; without skin they are background like any other.
export function lookBands(own = {}, target = {}, { skin = true } = {}) {
  const hsl = {};
  for (const k of ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']) {
    if (skin && (k === 'red' || k === 'orange')) continue;
    const o = own[k], t = target[k];
    if (!o || !t || !(o.weight >= 0.02) || !(o.chroma > 8) || !(t.weight >= 0.01) || !(t.chroma > 5)) continue;
    const sat = Math.round(clamp((t.chroma / o.chroma - 1) * 100, -100, 100));
    const hue = Math.round(clamp(angDiff(t.hue, o.hue) / 30 * 100, -100, 100));
    const lum = Math.round(clamp(((t.lumRel || 0) - (o.lumRel || 0)) * 5, -100, 100));
    if (near0(sat, hue, lum)) continue;
    hsl[`hue_${k}`] = hue; hsl[`sat_${k}`] = sat; hsl[`lum_${k}`] = lum;
  }
  return { point: null, hsl };
}

// S-curve strength for the master curve: how many curve units the quartiles move apart (shadows down,
// highlights up) around the midpoint. Never below S_MIN, so every photo gets some S; a flat photo or a
// punchier look gets more. spread = the photo's own quartile spread, want = the look's (else AUTO default).
export const S_MIN = 5, S_MAX = 60, S_DEFAULT_SPREAD = 92;
export function sCurvePush(spread, want = null) {
  const target = Number.isFinite(want) ? want : S_DEFAULT_SPREAD;
  return clamp((target - spread) * 0.3, S_MIN, S_MAX);
}

// Overall colour intensity toward the look's mean chroma.
export function lookPresence(ownChroma, targetChroma) {
  if (!(ownChroma > 1) || !(targetChroma > 0)) return null;
  const r = targetChroma / ownChroma;
  return { saturation: Math.round(clamp((r - 1) * 60, -100, 100)), vibrance: Math.round(clamp((r - 1) * 100, -100, 100)) };
}

// ---- R/G/B channel curves toward a look. Per tonal zone (shadows, midtones, highlights) the photo's colour
// (Lab a*, b*) is moved onto the look's: how many 0-255 code values each channel has to shift at that zone's
// curve position for the photo's colour there to land on the look's. The part that is the same in all three
// channels is dropped, because brightness belongs to the master curve.
// own, target: measure().zones ({ shadows|midtones|highlights: { a, b, mass } }). Returns
// { x: [64, 128, 192], d: [[dr, dg, db] x 3] } or null when no zone can be compared.
export const CHANNEL_ANCHORS = [64, 128, 192];
const ZONE_L = [27, 54, 78], ZONE_KEYS = ['shadows', 'midtones', 'highlights'];
const rgb8 = (L, a, b) => labToLin(L, a, b, [0, 0, 0]).map((v) => 255 * linearToSrgb(clamp(v, 0, 1)));
export function zoneChannelShifts(own = {}, target = {}, minMass = 0.02) {
  const d = ZONE_KEYS.map((k, i) => {
    const o = own[k], t = target[k];
    if (!o || !t || !(o.mass >= minMass) || !(t.mass >= minMass) || ![o.a, o.b, t.a, t.b].every(Number.isFinite)) return [0, 0, 0];
    const base = rgb8(ZONE_L[i], o.a, o.b), want = rgb8(ZONE_L[i], t.a, t.b);
    const diff = want.map((v, c) => v - base[c]), mean = (diff[0] + diff[1] + diff[2]) / 3;
    return diff.map((v) => Math.round((v - mean) * 10) / 10);
  });
  return d.some((z) => z.some((v) => Math.abs(v) >= 0.5)) ? { x: CHANNEL_ANCHORS, d } : null;
}

// Add those shifts to a channel curve (array of [x, y] in 0-255): at each anchor the curve's own value plus the
// shift, keeping the points in order and the curve rising.
export function applyChannelShift(pts, evalAt, shifts, channel) {
  if (!shifts) return pts;
  const keep = pts.filter(([x]) => x === 0 || x === 255 || shifts.x.every((ax) => Math.abs(x - ax) >= 24));
  const out = keep.slice();
  shifts.x.forEach((x, z) => {
    const dz = shifts.d[z][channel];
    if (Math.abs(dz) < 0.5) return;
    out.push([x, Math.round(clamp(evalAt(x) + dz, 1, 254))]);
  });
  out.sort((a, b) => a[0] - b[0]);
  const res = [];
  for (const q of out) {
    const prev = res[res.length - 1];
    if (prev && (q[0] <= prev[0] || q[1] <= prev[1])) {
      if (q[0] === 255 && q[1] < prev[1]) { res.pop(); res.push(q); }
      continue;
    }
    res.push(q);
  }
  return res;
}
