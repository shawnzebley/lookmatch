// Lightroom / Camera Raw settings (crs:) from solved params.
// mode 'sliders': Basic-panel sliders + fade points in the point curve (editable, approximate).
// mode 'curve'  : the whole tone map baked into ToneCurvePV2012 (closer match, Basic tone sliders at 0).

import { SLIDERS, toneMapL, fadeLevels, isIdentityCurve } from './pipeline.js';
import { srgbToLinear, linearToSrgb, yToL, lToY } from './color.js';
import { BANDS } from './measure.js';

const r0 = (v) => Math.round(v);
const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);

function curvePoints(p, mode) {
  // LR's point curve is on gamma-encoded values; we convert through L*.
  const pts = [];
  if (mode === 'curve') {
    for (const x of [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255]) {
      const L = yToL(srgbToLinear(x / 255));
      const q = { ...p };
      const y = 255 * linearToSrgb(lToY(toneMapL(L, q)));
      pts.push([x, Math.round(y)]);
    }
  } else if (!isIdentityCurve(p.curve) && !p.fadeBlacks && !p.fadeWhites) {
    pts.push(...p.curve);
  } else {
    const fl = fadeLevels(p);
    const lo = Math.round(255 * linearToSrgb(lToY(fl.lo * 100)));
    const hi = Math.round(255 * linearToSrgb(lToY(fl.hi * 100)));
    pts.push([0, lo], [255, hi]);
  }
  // dedupe x and keep monotonic
  const out = [];
  for (const [x, y] of pts) if (!out.length || x > out[out.length - 1][0]) out.push([x, Math.max(out.length ? out[out.length - 1][1] : 0, y)]);
  return out;
}

export function crsSettings(p, mode = 'sliders') {
  const a = {
    Version: '15.0', ProcessVersion: '11.0', HasSettings: 'True',
    WhiteBalance: p.temp || p.tint ? 'Custom' : 'As Shot',
    IncrementalTemperature: r0(p.temp), IncrementalTint: r0(p.tint),
    Vibrance: r0(p.vibrance), Saturation: r0(p.saturation),
    ToneCurveName2012: 'Custom',
  };
  if (mode === 'curve') {
    Object.assign(a, { Exposure2012: '0.00', Contrast2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0 });
  } else {
    Object.assign(a, {
      Exposure2012: (p.exposure >= 0 ? '+' : '') + p.exposure.toFixed(2),
      Contrast2012: r0(p.contrast), Highlights2012: r0(p.highlights), Shadows2012: r0(p.shadows),
      Whites2012: r0(p.whites), Blacks2012: r0(p.blacks),
    });
  }
  for (const b of BANDS) {
    const B = b[0].toUpperCase() + b.slice(1);
    a[`HueAdjustment${B}`] = r0(p[`hue_${b}`]);
    a[`SaturationAdjustment${B}`] = r0(p[`sat_${b}`]);
    a[`LuminanceAdjustment${B}`] = r0(p[`lum_${b}`]);
  }
  Object.assign(a, {
    SplitToningShadowHue: r0(p.shadowHue), SplitToningShadowSaturation: r0(p.shadowSat),
    SplitToningHighlightHue: r0(p.highlightHue), SplitToningHighlightSaturation: r0(p.highlightSat),
    SplitToningBalance: r0(p.gradeBalance),
    ColorGradeMidtoneHue: r0(p.midtoneHue), ColorGradeMidtoneSat: r0(p.midtoneSat),
    ColorGradeShadowLum: 0, ColorGradeMidtoneLum: 0, ColorGradeHighlightLum: 0,
    RedHue: r0(p.calRedHue || 0), RedSaturation: r0(p.calRedSat || 0), GreenHue: r0(p.calGreenHue || 0), GreenSaturation: r0(p.calGreenSat || 0),
    BlueHue: r0(p.calBlueHue || 0), BlueSaturation: r0(p.calBlueSat || 0), ShadowTint: r0(p.calShadowTint || 0),
    ColorGradeBlending: 50, ColorGradeGlobalHue: 0, ColorGradeGlobalSat: 0, ColorGradeGlobalLum: 0,
  });
  const ch = (k) => (isIdentityCurve(p[k]) ? [[0, 0], [255, 255]] : p[k]);
  return { attrs: a, curve: curvePoints(p, mode), curveR: ch('curveR'), curveG: ch('curveG'), curveB: ch('curveB') };
}

function seq(tag, pts) {
  return `   <crs:${tag}>\n    <rdf:Seq>\n${pts.map(([x, y]) => `     <rdf:li>${x}, ${y}</rdf:li>`).join('\n')}\n    </rdf:Seq>\n   </crs:${tag}>`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// XMP packet to embed in a JPEG (Lightroom reads embedded XMP on import for JPEG/HEIC/TIFF)
export function xmpPacket(p, mode = 'sliders') {
  const { attrs, curve, curveR, curveG, curveB } = crsSettings(p, mode);
  const at = Object.entries(attrs).map(([k, v]) => `   crs:${k}="${esc(v)}"`).join('\n');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="LookMatch">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${at}>
${seq('ToneCurvePV2012', curve)}
${seq('ToneCurvePV2012Red', curveR)}
${seq('ToneCurvePV2012Green', curveG)}
${seq('ToneCurvePV2012Blue', curveB)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// A Lightroom develop preset (.xmp) holding this photo's computed settings. Import it in
// Lightroom (mobile: Presets > ... > Import Presets; Classic: Develop > Presets > Import) and apply to the original.
export function xmpPreset(p, name, mode = 'sliders') {
  const { attrs, curve, curveR, curveG, curveB } = crsSettings(p, mode);
  const uuid = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/-/g, '').toUpperCase().slice(0, 32);
  const head = {
    PresetType: 'Normal', Cluster: '', UUID: uuid, SupportsAmount: 'False', SupportsColor: 'True', SupportsMonochrome: 'False',
    SupportsHighDynamicRange: 'True', SupportsNormalDynamicRange: 'True', SupportsSceneReferred: 'True', SupportsOutputReferred: 'True',
    CameraModelRestriction: '', Copyright: '', ContactInfo: '',
  };
  const all = { ...head, ...attrs };
  delete all.WhiteBalance;
  const at = Object.entries(all).map(([k, v]) => `   crs:${k}="${esc(v)}"`).join('\n');
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="LookMatch">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${at}>
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(name)}</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">LookMatch</rdf:li>
    </rdf:Alt>
   </crs:Group>
${seq('ToneCurvePV2012', curve)}
${seq('ToneCurvePV2012Red', curveR)}
${seq('ToneCurvePV2012Green', curveG)}
${seq('ToneCurvePV2012Blue', curveB)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

export { sgn };
