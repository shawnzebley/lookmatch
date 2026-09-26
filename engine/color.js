// Color math shared by measurement and the edit pipeline.
// Working space: sRGB primaries, D65. Perceptual space: CIELAB (D65).

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// 8-bit decode table
export const SRGB8_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB8_TO_LIN[i] = srgbToLinear(i / 255);

const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const EPS = 216 / 24389, KAPPA = 24389 / 27;

function f(t) { return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116; }
function finv(t) { const t3 = t * t * t; return t3 > EPS ? t3 : (116 * t - 16) / KAPPA; }

export function luminance(r, g, b) { // linear
  return 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
}

// Y (linear luminance, 0-1) <-> L* (0-100)
export function yToL(y) { return y > EPS ? 116 * Math.cbrt(y) - 16 : KAPPA * y; }
export function lToY(L) { return L > 8 ? Math.pow((L + 16) / 116, 3) : L / KAPPA; }

// linear sRGB -> Lab, writes into out[0..2]
export function linToLab(r, g, b, out) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fx = f(x), fy = f(y), fz = f(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

export function labToLin(L, a, b, out) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = finv(fx) * XN, y = (L > 8 ? fy * fy * fy : L / KAPPA) * YN, z = finv(fz) * ZN;
  out[0] = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  out[1] = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  out[2] = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return out;
}

// HSV hue (degrees, 0-360) of a gamma-encoded or linear RGB triple
export function rgbHue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d <= 1e-9) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

// Lab a*b* unit direction for a Lightroom-style wheel hue (degrees, HSV hue of the tint color).
const _lab = [0, 0, 0];
export function wheelHueToAB(h) {
  const [r, g, b] = hsvToRgb(h, 0.35, 0.6);
  linToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), _lab);
  const n = Math.hypot(_lab[1], _lab[2]) || 1;
  return [_lab[1] / n, _lab[2] / n];
}

// inverse: a*b* direction -> wheel hue (searched on a 1-degree table)
const WHEEL = [];
for (let h = 0; h < 360; h++) WHEEL.push(wheelHueToAB(h));
export function abToWheelHue(a, b) {
  const n = Math.hypot(a, b);
  if (n < 1e-9) return 0;
  const ua = a / n, ub = b / n;
  let best = 0, bd = -2;
  for (let h = 0; h < 360; h++) {
    const d = WHEEL[h][0] * ua + WHEEL[h][1] * ub;
    if (d > bd) { bd = d; best = h; }
  }
  return best;
}

export function wrapDeg(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; }

// Lab (a*,b*) cast -> approximate correlated color temperature shift description.
// We report the cast of neutrals as a*, b* plus an approximate CCT/Duv of the neutral chromaticity.
export function labToCctDuv(L, a, b) {
  const lin = labToLin(L, a, b, [0, 0, 0]);
  const X = 0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2];
  const Y = 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.072175 * lin[2];
  const Z = 0.0193339 * lin[0] + 0.119192 * lin[1] + 0.9503041 * lin[2];
  const s = X + Y + Z || 1;
  const x = X / s, y = Y / s;
  // McCamy
  const n = (x - 0.332) / (0.1858 - y);
  const cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
  // Duv via Ohno-ish approximation on 1960 uv
  const u = 4 * x / (-2 * x + 12 * y + 3), v = 6 * y / (-2 * x + 12 * y + 3);
  const k6 = -0.00616793, k5 = 0.0893944, k4 = -0.5179722, k3 = 1.5317403, k2 = -2.4243787, k1 = 1.925865, k0 = -0.471106;
  const Lfp = Math.sqrt((u - 0.292) ** 2 + (v - 0.24) ** 2);
  const a1 = Math.acos((u - 0.292) / Lfp);
  const Lbb = k6 * a1 ** 6 + k5 * a1 ** 5 + k4 * a1 ** 4 + k3 * a1 ** 3 + k2 * a1 ** 2 + k1 * a1 + k0;
  return { cct: Math.round(cct), duv: +(Lfp - Lbb).toFixed(4) };
}
