// Lightroom / Camera Raw settings (crs:) from solved params.
// mode 'sliders': Basic-panel sliders + fade points in the point curve (editable, approximate).
// mode 'curve'  : the whole tone map baked into ToneCurvePV2012 (closer match, Basic tone sliders at 0).

import { SLIDERS, toneMapL, fadeLevels, isIdentityCurve, localActive, REGIONS } from './pipeline.js';
import { srgbToLinear, linearToSrgb, yToL, lToY, wheelHueToAB, abToWheelHue } from './color.js';
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
    PostCropVignetteAmount: r0(p.vignette || 0), PostCropVignetteMidpoint: 50, PostCropVignetteFeather: 60, PostCropVignetteStyle: 1,
    GrainAmount: r0(p.grain || 0), GrainSize: r0(p.grainSize || 25), GrainFrequency: 50,
    ColorGradeBlending: 50, ColorGradeGlobalHue: 0, ColorGradeGlobalSat: 0, ColorGradeGlobalLum: 0,
  });
  const ch = (k) => (isIdentityCurve(p[k]) ? [[0, 0], [255, 255]] : p[k]);
  return { attrs: a, curve: curvePoints(p, mode), curveR: ch('curveR'), curveG: ch('curveG'), curveB: ch('curveB') };
}

// Subject / background amounts as Lightroom masks: an AI "Select Subject" mask (MaskSubType 1), inverted for
// the background, so Lightroom finds the subject again on its side. Local values are -1..1 (exposure: stops / 4).
// Lightroom masks have no vibrance (folded into saturation) and one colour swatch instead of three wheels.
// Not yet checked against Lightroom itself.
const LOCAL_CRS = { exposure: ['LocalExposure2012', 4], contrast: ['LocalContrast2012', 100], highlights: ['LocalHighlights2012', 100], shadows: ['LocalShadows2012', 100],
  whites: ['LocalWhites2012', 100], blacks: ['LocalBlacks2012', 100], temp: ['LocalTemperature', 100], tint: ['LocalTint', 100], saturation: ['LocalSaturation', 100] };
const guid = () => `{${(globalThis.crypto?.randomUUID?.() || '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0')).toUpperCase()}}`;
const f6 = (v) => (+v).toFixed(6);
export function maskCorrections(p) {
  if (!p.local) return '';
  const items = [];
  for (const r of REGIONS) {
    const loc = p.local[r];
    if (!localActive(loc)) continue;
    const at = { What: 'Correction', CorrectionAmount: f6(1), CorrectionActive: 'true', CorrectionName: r === 'subject' ? 'LookMatch subject' : 'LookMatch background', CorrectionSyncID: guid() };
    for (const [k, [name, div]] of Object.entries(LOCAL_CRS)) at[name] = f6(Math.max(-1, Math.min(1, (loc[k] || 0) / div)));
    if (loc.vibrance) at.LocalSaturation = f6(Math.max(-1, Math.min(1, (loc.saturation || 0) / 100 + 0.6 * loc.vibrance / 100)));
    // three local wheels -> one colour swatch (midtones count most)
    let a = 0, b = 0;
    for (const [z, w] of [['shadow', 0.3], ['midtone', 0.5], ['highlight', 0.2]]) { const sat = loc[`${z}Sat`] || 0; if (sat) { const [u, v] = wheelHueToAB(loc[`${z}Hue`] || 0); a += w * u * sat; b += w * v * sat; } }
    const sat = Math.min(100, Math.hypot(a, b) / 0.5);
    at.LocalToningHue = f6(sat > 0.5 ? abToWheelHue(a, b) : 0); at.LocalToningSaturation = f6(sat / 100);
    const attrs = Object.entries(at).map(([k, v]) => `       crs:${k}="${v}"`).join('\n');
    items.push(`     <rdf:li>
      <rdf:Description
${attrs}>
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/Image"
         crs:MaskActive="true"
         crs:MaskName="Subject"
         crs:MaskBlendMode="0"
         crs:MaskInverted="${r === 'background'}"
         crs:MaskSyncID="${guid()}"
         crs:MaskValue="1.000000"
         crs:MaskSubType="1"
         crs:ReferencePoint="0.500000 0.500000"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>`);
  }
  if (!items.length) return '';
  return `   <crs:MaskGroupBasedCorrections>\n    <rdf:Seq>\n${items.join('\n')}\n    </rdf:Seq>\n   </crs:MaskGroupBasedCorrections>\n`;
}

function seq(tag, pts) {
  return `   <crs:${tag}>\n    <rdf:Seq>\n${pts.map(([x, y]) => `     <rdf:li>${x}, ${y}</rdf:li>`).join('\n')}\n    </rdf:Seq>\n   </crs:${tag}>`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// XMP packet to embed in a JPEG (Lightroom reads embedded XMP on import for JPEG/HEIC/TIFF)
export function xmpPacket(p, mode = 'sliders', extra = null) {
  const { attrs, curve, curveR, curveG, curveB } = crsSettings(p, mode);
  if (extra) Object.assign(attrs, extra);
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
${maskCorrections(p)}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// A Lightroom develop preset (.xmp) holding this photo's computed settings. Import it in
// Lightroom (mobile: Presets > ... > Import Presets; Classic: Develop > Presets > Import) and apply to the original.
export function xmpPreset(p, name, mode = 'sliders', extra = null) {
  const { attrs, curve, curveR, curveG, curveB } = crsSettings(p, mode);
  if (extra) Object.assign(attrs, extra);
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
${maskCorrections(p)}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

export { sgn };
