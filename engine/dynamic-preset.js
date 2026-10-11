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

function stepList(s, entry, params) {
  const wb = s.WhiteBalance === 'Custom' ? `${s.Temperature}K / tint ${sgn(s.Tint)} on the original raw file. Not copied: each photo gets its own neutral balance first` : 'As shot. Each photo gets its own neutral balance';
  const hsl = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']
    .filter((b) => s[`HueAdjustment${b}`] || s[`SaturationAdjustment${b}`] || s[`LuminanceAdjustment${b}`])
    .map((b) => `${b} ${sgn(s[`HueAdjustment${b}`] || 0)}/${sgn(s[`SaturationAdjustment${b}`] || 0)}/${sgn(s[`LuminanceAdjustment${b}`] || 0)}`);
  const zone = (name, h, sat) => (sat ? `${name} ${h}°/${sat}` : null);
  const grade = [zone('shadows', s.SplitToningShadowHue, s.SplitToningShadowSaturation), zone('midtones', s.ColorGradeMidtoneHue, s.ColorGradeMidtoneSat), zone('highlights', s.SplitToningHighlightHue, s.SplitToningHighlightSaturation)].filter(Boolean);
  const param = PARAMETRIC.filter(([k]) => s[k]).map(([k]) => `${k.replace('Parametric', '').toLowerCase()} ${sgn(s[k])}`);
  const steps = [
    { step: 'Light', applied: true, detail: `Exposure ${sgn(s.Exposure2012)}, Contrast ${sgn(s.Contrast2012)}, Highlights ${sgn(s.Highlights2012)}, Shadows ${sgn(s.Shadows2012)}, Whites ${sgn(s.Whites2012)}, Blacks ${sgn(s.Blacks2012)}` },
    { step: 'White balance', applied: false, detail: wb },
    { step: 'Presence', applied: true, detail: `Vibrance ${sgn(s.Vibrance)}, Saturation ${sgn(s.Saturation)}` },
    { step: 'Tone curve', applied: true, detail: `Point and R/G/B curves${param.length ? `, parametric ${param.join(', ')} (approximated)` : ''}${entry.wholeImageCurves?.length ? ', plus the whole-image fade curve' : ''}` },
    { step: 'HSL', applied: true, detail: hsl.length ? `hue/sat/lum: ${hsl.join(', ')}` : 'none' },
    { step: 'Color grading', applied: true, detail: `${grade.join(', ') || 'none'}; balance ${sgn(s.SplitToningBalance || 0)}${s.ColorGradeBlending != null && s.ColorGradeBlending !== 100 ? `; blending ${s.ColorGradeBlending} not applied (app blends at 100)` : ''}` },
    { step: 'Effects', applied: !!params.grain, detail: `Grain ${s.GrainAmount || 0}, size ${s.GrainSize || 0}${['Texture', 'Clarity2012', 'Dehaze'].some((k) => s[k]) ? `. Not applied: Texture ${sgn(s.Texture || 0)}, Clarity ${sgn(s.Clarity2012 || 0)}, Dehaze ${sgn(s.Dehaze || 0)}` : ''}` },
  ];
  for (const m of entry.masks || []) steps.push({ step: `Mask: ${m.label}`, applied: false, detail: m.detail });
  return steps;
}

// entry: one record of a looks manifest; settings: parsePreset(xmp).settings.
export function dynamicPreset(entry, settings) {
  const params = toParams(settings);
  const curve = masterCurve(settings, entry.wholeImageCurves || []);
  if (isIdentityCurve(curve)) delete params.curve; else params.curve = curve;
  const notApplied = unsupported(settings).filter((x) => x !== 'parametric curve');
  if (typeof settings.ColorGradeBlending === 'number' && settings.ColorGradeBlending !== 100) notApplied.push('grade blending');
  if (settings.WhiteBalance === 'Custom') notApplied.push('Kelvin white balance');
  if (entry.masks?.length) notApplied.push(`${entry.masks.length} local mask${entry.masks.length > 1 ? 's' : ''}`);
  return { params, notApplied, steps: stepList(settings, entry, params) };
}
