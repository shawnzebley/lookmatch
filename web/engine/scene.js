// Scene brightness from camera settings. EV100 = log2(N^2 / t) - log2(ISO / 100).
// Rough guide: daylight 12-16, overcast/shade 9-12, bright interior 6-9, dim interior/dusk 3-6, night < 3.

export const EXIF_TAGS = ['ISO', 'ExposureTime', 'FNumber', 'Flash', 'ExposureCompensation', 'Make', 'Model'];

export function sceneFromExif(e) {
  if (!e) return null;
  const iso = +e.ISO || +e.ISOSpeedRatings || 0, t = +e.ExposureTime || 0, n = +e.FNumber || 0;
  if (!iso || !t || !n) return null;
  const ev = Math.log2((n * n) / t) - Math.log2(iso / 100);
  const flashFired = typeof e.Flash === 'number' ? (e.Flash & 1) === 1 : /fired/i.test(String(e.Flash || '')) && !/not fire|did not/i.test(String(e.Flash));
  const label = ev >= 12 ? 'daylight' : ev >= 9 ? 'overcast / shade' : ev >= 6 ? 'bright interior' : ev >= 3 ? 'dim interior / dusk' : 'night';
  const shutter = t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}`;
  return { ev: +ev.toFixed(2), iso, shutter, aperture: n, flash: flashFired, label, camera: [e.Make, e.Model].filter(Boolean).join(' ').trim() };
}

// How far a photo may be pulled toward a brighter reference. Dark scenes (low EV) should stay dark;
// a dark photo of a bright scene (underexposed daylight) may be brought up. Flash shots judge by the image.
export function brightenFactor(scene) {
  if (!scene || scene.flash) return null;
  return Math.min(1, Math.max(0.1, (scene.ev - 2) / 7));
}
