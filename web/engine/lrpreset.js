// Read Lightroom develop presets (.lrtemplate Lua tables and .xmp crs: files) into a flat settings
// object, then map what LookMatch can reproduce onto its sliders and list what it can't.
// Preset VALUES never get committed (repo is public, the packs are paid); this file only parses.

import { SLIDERS } from './pipeline.js';

// ---- parsing ------------------------------------------------------------------------------
function num(v) {
  const t = String(v).trim().replace(/^"|"$/g, '');
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  const n = Number(t.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : t;
}

function parseLrtemplate(text) {
  const s = {};
  const title = /\btitle\s*=\s*"([^"]*)"/.exec(text);
  // top-level scalar settings only (skip nested local corrections, which carry Local* keys)
  const body = text.slice(text.indexOf('settings'));
  for (const m of body.matchAll(/^\s*([A-Za-z0-9]+)\s*=\s*("[^"]*"|[-+\d.]+|true|false)\s*,/gm)) {
    if (!(m[1] in s)) s[m[1]] = num(m[2]);
  }
  // curves: Key = { 0, 0, 64, 71, ... }
  for (const m of body.matchAll(/^\s*(ToneCurvePV2012(?:Red|Green|Blue)?)\s*=\s*\{([^}]*)\}/gm)) {
    const v = m[2].split(',').map((x) => x.trim()).filter(Boolean).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
    s[m[1]] = pts;
  }
  s.hasLocal = /GradientBasedCorrections\s*=\s*\{\s*\{/.test(text) || /CircularGradientBasedCorrections\s*=\s*\{\s*\{/.test(text) || /PaintBasedCorrections\s*=\s*\{\s*\{/.test(text);
  return { name: title ? title[1] : '', settings: s };
}

function parseXmp(text) {
  const s = {};
  for (const m of text.matchAll(/crs:([A-Za-z0-9]+)="([^"]*)"/g)) s[m[1]] = num(m[2]);
  for (const m of text.matchAll(/<crs:(ToneCurvePV2012(?:Red|Green|Blue)?)>([\s\S]*?)<\/crs:\1>/g)) {
    s[m[1]] = [...m[2].matchAll(/<rdf:li>\s*([-\d.]+)\s*,\s*([-\d.]+)\s*<\/rdf:li>/g)].map((x) => [+x[1], +x[2]]);
  }
  const name = /<crs:Name>[\s\S]*?<rdf:li[^>]*>([^<]*)</.exec(text);
  s.hasLocal = /crs:(GradientBasedCorrections|CircularGradientBasedCorrections|PaintBasedCorrections)>/.test(text);
  return { name: name ? name[1] : '', settings: s };
}

export function parsePreset(text, fileName = '') {
  const r = /<x:xmpmeta|crs:/.test(text) ? parseXmp(text) : parseLrtemplate(text);
  if (!r.name) r.name = fileName.replace(/\.(lrtemplate|xmp)$/i, '');
  return r;
}

// ---- mapping onto LookMatch -------------------------------------------------------------------
const IDENTITY = (pts) => !pts || pts.every(([x, y]) => x === y);

// LR split toning hue is 0-359 on the same wheel the app uses; balance -100..100 matches gradeBalance.
export function toParams(settings) {
  const p = {};
  const lrKeys = Object.fromEntries(SLIDERS.filter((d) => d.lr).map((d) => [d.lr, d.key]));
  for (const [lr, key] of Object.entries(lrKeys)) if (typeof settings[lr] === 'number') p[key] = settings[lr];
  // Absolute Temperature/Tint (Kelvin) only mean something on the raw file they were made on; skipped.
  // Preset mode's auto white balance takes that job instead.
  const curveKey = { ToneCurvePV2012: 'curve', ToneCurvePV2012Red: 'curveR', ToneCurvePV2012Green: 'curveG', ToneCurvePV2012Blue: 'curveB' };
  for (const [lr, k] of Object.entries(curveKey)) if (Array.isArray(settings[lr]) && !IDENTITY(settings[lr])) p[k] = settings[lr];
  if (settings.SplitToningShadowSaturation) { p.shadowHue = settings.SplitToningShadowHue; p.shadowSat = settings.SplitToningShadowSaturation; }
  if (settings.SplitToningHighlightSaturation) { p.highlightHue = settings.SplitToningHighlightHue; p.highlightSat = settings.SplitToningHighlightSaturation; }
  if (typeof settings.SplitToningBalance === 'number') p.gradeBalance = settings.SplitToningBalance;
  for (const z of ['Shadow', 'Midtone', 'Highlight']) {
    const sat = settings[`ColorGrade${z}Sat`];
    if (sat) { p[`${z.toLowerCase()}Hue`] = settings[`ColorGrade${z}Hue`]; p[`${z.toLowerCase()}Sat`] = sat; }
  }
  if (typeof settings.ColorGradeGlobalSat === 'number' && settings.ColorGradeGlobalSat) p._globalGrade = [settings.ColorGradeGlobalHue, settings.ColorGradeGlobalSat];
  return p;
}

// Everything in the preset that changes the picture but has no LookMatch control yet.
export function unsupported(settings) {
  const out = [];
  const nz = (k) => typeof settings[k] === 'number' && settings[k] !== 0;
  if (['ParametricShadows', 'ParametricDarks', 'ParametricLights', 'ParametricHighlights'].some(nz)) out.push('parametric curve');
  if (nz('Clarity2012')) out.push('clarity');
  if (nz('Dehaze')) out.push('dehaze');
  if (nz('Texture')) out.push('texture');
  if (nz('VignetteAmount') && !nz('PostCropVignetteAmount')) out.push('lens vignette');
  if (settings.ConvertToGrayscale === true) out.push('B&W mix');
  if (settings.hasLocal) out.push('local masks');
  if (typeof settings.CameraProfile === 'string' && !/^Adobe Standard$|^Embedded$/.test(settings.CameraProfile)) out.push(`profile: ${settings.CameraProfile}`);
  return out;
}
