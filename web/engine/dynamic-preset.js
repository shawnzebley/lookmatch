// Built-in dynamic presets: a photographer's published Lightroom recipe (.xmp, exact global
// sliders) plus the whole-image steps an .xmp can't hold. They run through solvePreset, so every
// photo first gets its own exposure and white-balance normalisation, then the recipe on top.
// The step list follows the order the photographer showed the edit, and says what is not applied.

import { toParams, unsupported } from './lrpreset.js';
import { curveLUT, isIdentityCurve } from './pipeline.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);

// Lightroom's parametric curve has no published formula. Approximation: each region slider adds a
// raised-cosine bump centred in its region (splits at 25/50/75), ±100 moving the peak about ±30
// levels, with the end points held so black and white stay put.
const PARAMETRIC = [['ParametricShadows', 0.125], ['ParametricDarks', 0.375], ['ParametricLights', 0.625], ['ParametricHighlights', 0.875]];
export function parametricOffset(x, settings) {
  const t = x / 255;
  let off = 0;
  for (const [k, c] of PARAMETRIC) {
    const v = settings[k];
    if (typeof v !== 'number' || !v) continue;
    const d = Math.abs(t - c) / 0.25;
    if (d < 1) off += (v / 100) * 30 * 0.5 * (1 + Math.cos(Math.PI * d));
  }
  return off * Math.min(1, 4 * t, 4 * (1 - t));
}

const sampler = (pts) => {
  if (isIdentityCurve(pts)) return (x) => x;
  const lut = curveLUT(pts);
  return (x) => { const f = clamp(x / 255, 0, 1) * 1023, i = Math.min(1022, f | 0); return 255 * (lut[i] + (lut[i + 1] - lut[i]) * (f - i)); };
};

// Parametric first, then the point curve (Lightroom's order), then any whole-image curve masks.
export function masterCurve(settings, wholeImageCurves = []) {
  const point = sampler(settings.ToneCurvePV2012);
  const extra = wholeImageCurves.map(sampler);
  const out = [];
  for (let x = 0; x <= 256; x += 16) {
    const xi = Math.min(255, x);
    let y = point(clamp(xi + parametricOffset(xi, settings), 0, 255));
    for (const f of extra) y = f(y);
    out.push([xi, Math.round(clamp(y, 0, 255) * 10) / 10]);
  }
  return out;
}

// Lightroom's Kelvin white balance on a raw file, as a shift from daylight (5500K, tint +10) on the
// app's relative Temp/Tint. Blackbody chromaticity from Kim et al. (2002); the app's Temp moves
// ln(R/B) by 0.7 per 100, so the shift is the change in the illuminant's R/B ratio.
function planckRGB(T) {
  T = clamp(T, 1667, 25000);
  const x = T <= 4000 ? -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.179910
    : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.240390;
  const y = T <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y, Z = (1 - x - y) / y;
  return [3.2404542 * X - 1.5371385 - 0.4985314 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z];
}
export const DAYLIGHT_K = 5500, DAYLIGHT_TINT = 10;
export function kelvinToRelative(kelvin, tint = DAYLIGHT_TINT) {
  const [r0, b0] = planckRGB(DAYLIGHT_K), [r1, b1] = planckRGB(kelvin);
  const temp = (Math.log(r0 / r1) - Math.log(b0 / b1)) / 0.7 * 100;
  return { temp: Math.round(clamp(temp, -100, 100)), tint: Math.round(clamp(tint - DAYLIGHT_TINT, -100, 100)) };
}

function stepList(s, entry, params) {
  const kel = params._kelvin;
  const wb = s.WhiteBalance === 'Custom'
    ? `${s.Temperature}K / tint ${sgn(s.Tint)} on the original raw file. Each photo is neutralised first, then shifted from daylight by Temp ${sgn(kel.temp)}, Tint ${sgn(kel.tint)}`
    : 'As shot. Each photo gets its own neutral balance';
  const hsl = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']
    .filter((b) => s[`HueAdjustment${b}`] || s[`SaturationAdjustment${b}`] || s[`LuminanceAdjustment${b}`])
    .map((b) => `${b} ${sgn(s[`HueAdjustment${b}`] || 0)}/${sgn(s[`SaturationAdjustment${b}`] || 0)}/${sgn(s[`LuminanceAdjustment${b}`] || 0)}`);
  const zone = (name, h, sat) => (sat ? `${name} ${h}°/${sat}` : null);
  const grade = [zone('shadows', s.SplitToningShadowHue, s.SplitToningShadowSaturation), zone('midtones', s.ColorGradeMidtoneHue, s.ColorGradeMidtoneSat), zone('highlights', s.SplitToningHighlightHue, s.SplitToningHighlightSaturation)].filter(Boolean);
  const param = PARAMETRIC.filter(([k]) => s[k]).map(([k]) => `${k.replace('Parametric', '').toLowerCase()} ${sgn(s[k])}`);
  const steps = [
    { step: 'Light', applied: true, detail: `Exposure ${sgn(s.Exposure2012)}, Contrast ${sgn(s.Contrast2012)}, Highlights ${sgn(s.Highlights2012)}, Shadows ${sgn(s.Shadows2012)}, Whites ${sgn(s.Whites2012)}, Blacks ${sgn(s.Blacks2012)}` },
    { step: 'White balance', applied: true, detail: wb },
    { step: 'Presence', applied: true, detail: `Vibrance ${sgn(s.Vibrance)}, Saturation ${sgn(s.Saturation)}` },
    { step: 'Tone curve', applied: true, detail: `Point and R/G/B curves${param.length ? `, parametric ${param.join(', ')} (approximated)` : ''}${entry.wholeImageCurves?.length ? ', plus the whole-image fade curve' : ''}` },
    { step: 'HSL', applied: true, detail: hsl.length ? `hue/sat/lum: ${hsl.join(', ')}` : 'none' },
    { step: 'Color grading', applied: true, detail: `${grade.join(', ') || 'none'}; balance ${sgn(s.SplitToningBalance || 0)}; blending ${s.ColorGradeBlending ?? 50}` },
    { step: 'Effects', applied: true, detail: `Texture ${sgn(s.Texture || 0)}, Clarity ${sgn(s.Clarity2012 || 0)}, Dehaze ${sgn(s.Dehaze || 0)}, Grain ${s.GrainAmount || 0} (size ${s.GrainSize || 0}, roughness ${s.GrainFrequency ?? 50})` },
  ];
  for (const m of entry.masks || []) steps.push({ step: `Mask: ${m.label}`, applied: !!m.spec, detail: m.spec ? `${m.detail}. Placed on each photo: ${PLACED[m.spec.kind](m.spec)}` : m.detail });
  return steps;
}

const PLACED = {
  linear: (m) => `fades in from the ${m.from.replace(/([A-Z])/g, ' $1').toLowerCase()} edge`,
  radial: (m) => ({ light: 'centred where the light comes from', subject: 'around the detected subject', fixed: 'same spot on every photo' })[m.anchor || 'fixed'],
  sky: () => 'detected sky',
  skin: () => 'detected skin',
  eyes: () => 'detected irises',
  all: () => 'whole photo',
};

// entry: one record of a looks manifest; settings: parsePreset(xmp).settings.
export function dynamicPreset(entry, settings) {
  const params = toParams(settings);
  const curve = masterCurve(settings, entry.wholeImageCurves || []);
  if (isIdentityCurve(curve)) delete params.curve; else params.curve = curve;
  if (settings.WhiteBalance === 'Custom' && typeof settings.Temperature === 'number') {
    const k = kelvinToRelative(settings.Temperature, settings.Tint ?? DAYLIGHT_TINT);
    params.temp = k.temp; params.tint = k.tint;
    Object.defineProperty(params, '_kelvin', { value: k, enumerable: false });
  }
  const specs = (entry.masks || []).filter((m) => m.spec).map((m) => m.spec);
  if (specs.length) params.lookMasks = specs;
  const notApplied = unsupported(settings).filter((x) => !['parametric curve', 'clarity', 'dehaze', 'texture', 'local masks'].includes(x));
  const unplaced = (entry.masks || []).filter((m) => !m.spec).length;
  if (unplaced) notApplied.push(`${unplaced} local mask${unplaced > 1 ? 's' : ''}`);
  return { params, notApplied, steps: stepList(settings, entry, params) };
}
