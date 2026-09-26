// Measurement module. Works on a small preview (about 512 px on the long side).
// prepare() decodes pixels into linear RGB + Lab and fixes the pixel masks from the ORIGINAL image.
// measure() computes the stats for any (possibly edited) Lab/linear arrays using those fixed masks,
// so the solver compares like with like while it changes the image.

import { SRGB8_TO_LIN, linToLab, rgbHue, abToWheelHue, labToCctDuv } from './color.js';

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
export function gradeWeights(L, shift = 0, out = [0, 0, 0]) {
  const x = L / 100 - shift;
  const ws = 1 - smoothstep(0.12, 0.5, x);
  const wh = smoothstep(0.5, 0.88, x);
  out[0] = ws; out[1] = Math.max(0, 1 - ws - wh); out[2] = wh;
  return out;
}

export const PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99];
export const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
export const BAND_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];

// Partition-of-unity band weights on the hue circle (HSV hue of gamma RGB, like Lightroom's mixer).
export function bandWeights(h, out) {
  out.fill(0);
  const n = BAND_CENTERS.length;
  for (let i = 0; i < n; i++) {
    const c0 = BAND_CENTERS[i], c1 = i + 1 < n ? BAND_CENTERS[i + 1] : 360;
    let hh = h;
    if (i === n - 1 && hh < c0) hh += 360;
    if (hh >= c0 && hh < c1) {
      const t = (hh - c0) / (c1 - c0);
      const s = t * t * (3 - 2 * t);
      out[i] += 1 - s;
      out[(i + 1) % n] += s;
      return out;
    }
  }
  out[0] = 1;
  return out;
}

function percentileFromHist(hist, total, p, binW) {
  const target = (p / 100) * total;
  let c = 0;
  for (let i = 0; i < hist.length; i++) {
    const nc = c + hist[i];
    if (nc >= target) {
      const frac = hist[i] > 0 ? (target - c) / hist[i] : 0;
      return (i + frac) * binW;
    }
    c = nc;
  }
  return (hist.length) * binW;
}

function quantile(arr, p) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

/**
 * img: { width, height, data: Uint8Array|Uint8ClampedArray, channels: 3|4 }
 * returns PixelSet with original linear/Lab arrays and fixed masks.
 */
// Fill polygons (0..1 coords) into a mask at w x h (even-odd scanline).
export function polygonMask(polys, w, h) {
  const m = new Uint8Array(w * h);
  for (const poly of polys || []) {
    const pts = poly.map(([x, y]) => [x * w, y * h]);
    let y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > yc) !== (yj > yc)) xs.push(xi + ((yc - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = a; x <= b; x++) m[y * w + x] = 1;
      }
    }
  }
  return m;
}

export function prepare(img, opts = {}) {
  const { width, height, data } = img;
  const ch = img.channels || 4;
  const n = width * height;
  const lr = new Float32Array(n), lg = new Float32Array(n), lb = new Float32Array(n);
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const hue = new Float32Array(n);
  const maxG = new Uint8Array(n);
  const lab = [0, 0, 0];
  for (let i = 0, j = 0; i < n; i++, j += ch) {
    const r8 = data[j], g8 = data[j + 1], b8 = data[j + 2];
    const r = SRGB8_TO_LIN[r8], g = SRGB8_TO_LIN[g8], b = SRGB8_TO_LIN[b8];
    lr[i] = r; lg[i] = g; lb[i] = b;
    linToLab(r, g, b, lab);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    hue[i] = rgbHue(r8, g8, b8);
    maxG[i] = Math.max(r8, g8, b8);
  }
  const C = new Float32Array(n);
  for (let i = 0; i < n; i++) C[i] = Math.hypot(A[i], B[i]);

  // zones: the same soft L* weights the color-grading sliders use, fixed from the original.
  // Only the lower-chroma half of each zone counts (reveals the grade more than the content).
  const zw = new Float32Array(n * 3);
  const gw = [0, 0, 0];
  for (let i = 0; i < n; i++) { gradeWeights(L[i], 0, gw); zw[i * 3] = gw[0]; zw[i * 3 + 1] = gw[1]; zw[i * 3 + 2] = gw[2]; }
  const zone = new Uint8Array(n);
  for (let i = 0; i < n; i++) zone[i] = zw[i * 3] >= zw[i * 3 + 1] && zw[i * 3] >= zw[i * 3 + 2] ? 0 : zw[i * 3 + 2] > zw[i * 3 + 1] ? 2 : 1;
  const zoneTint = new Uint8Array(n);
  for (let z = 0; z < 3; z++) {
    const cs = [];
    for (let i = 0; i < n; i++) if (zone[i] === z) cs.push(C[i]);
    const med = quantile(cs, 50);
    for (let i = 0; i < n; i++) if (zone[i] === z && C[i] <= Math.max(med, 4)) zoneTint[i] = 1;
  }

  // neutral candidates: mid-tone, unclipped, lowest chroma, and (when enough remain) gray-edge consistent
  const midC = [];
  for (let i = 0; i < n; i++) if (L[i] > 12 && L[i] < 95 && maxG[i] < 250) midC.push(C[i]);
  const thr = Math.min(12, Math.max(2.5, quantile(midC, 15)));
  const neutral = new Uint8Array(n);
  let nCount = 0;
  for (let i = 0; i < n; i++) {
    if (L[i] > 12 && L[i] < 95 && maxG[i] < 250 && C[i] <= thr) { neutral[i] = 1; nCount++; }
  }
  // gray-edge test: log-RGB gradients line up on true grays
  let geCount = 0;
  const ge = new Uint8Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!neutral[i]) continue;
      const i2 = i + 1, i3 = i + width;
      const e = 1e-4;
      const dr = Math.log(lr[i2] + e) - Math.log(lr[i] + e) + Math.log(lr[i3] + e) - Math.log(lr[i] + e);
      const dg = Math.log(lg[i2] + e) - Math.log(lg[i] + e) + Math.log(lg[i3] + e) - Math.log(lg[i] + e);
      const db = Math.log(lb[i2] + e) - Math.log(lb[i] + e) + Math.log(lb[i3] + e) - Math.log(lb[i] + e);
      const mag = Math.abs(dg);
      if (mag < 0.02 || Math.abs(dr - dg) + Math.abs(db - dg) < 0.35 * mag) { ge[i] = 1; geCount++; }
    }
  }
  if (geCount > 0.005 * n) { neutral.set(ge); nCount = geCount; }
  const wbConfidence = Math.max(0.05, Math.min(1, nCount / (0.03 * n)) * Math.min(1, (14 - thr) / 8));

  // band membership (fixed from the original)
  const bw = new Float32Array(n * 8);
  const tmp = new Float32Array(8);
  for (let i = 0; i < n; i++) {
    const col = Math.min(1, Math.max(0, (C[i] - 6) / 10));
    if (col <= 0) continue;
    bandWeights(hue[i], tmp);
    for (let k = 0; k < 8; k++) bw[i * 8 + k] = tmp[k] * col;
  }

  // low-chroma set for vibrance
  const c60 = quantile(C, 60);
  const lowSat = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (C[i] <= c60) lowSat[i] = 1;

  // skin: inside detected face outlines (MediaPipe) when available, else a hue/chroma/lightness window.
  // Inside a face the color test is loose (any lighting cast), and only drops hair, eyes, beard shadow and specular.
  const skin = new Uint8Array(n);
  let skinSource = 'color';
  const faceMask = opts.faces && opts.faces.length ? polygonMask(opts.faces, width, height) : null;
  if (faceMask) {
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!faceMask[i]) continue;
      const h = Math.atan2(B[i], A[i]) * 180 / Math.PI;
      if (h > -10 && h < 100 && C[i] > 3 && L[i] > 22 && L[i] < 97) { skin[i] = 1; cnt++; }
    }
    if (cnt >= 30) skinSource = 'faces'; else skin.fill(0);
  }
  if (skinSource === 'color') {
    for (let i = 0; i < n; i++) {
      const h = Math.atan2(B[i], A[i]) * 180 / Math.PI;
      if (h > 20 && h < 75 && C[i] > 8 && C[i] < 50 && L[i] > 25 && L[i] < 92 && lr[i] > lg[i] && lg[i] > lb[i]) skin[i] = 1;
    }
  }

  // bright half of skin (lit side of faces) gets its own guard
  const sl = []; for (let i = 0; i < n; i++) if (skin[i]) sl.push(L[i]);
  const skinMed = quantile(sl, 50);
  for (let i = 0; i < n; i++) if (skin[i] && L[i] > skinMed) skin[i] = 2;

  return {
    width, height, n, lr, lg, lb, L, A, B, hue,
    masks: { zone, zw, zoneTint, neutral, bw, lowSat, skin },
    wbConfidence, neutralThreshold: thr, skinSource, faceCount: faceMask ? opts.faces.length : 0,
  };
}

/**
 * Compute stats. `cur` is optional { L, A, B, lr, lg, lb } of the edited image; defaults to the original.
 * `idx` optional Int32Array subset of pixel indices (used by the solver).
 */
export function measure(ps, cur, idx) {
  cur = cur || ps;
  const { L, A, B } = cur;
  const lin = cur.lr ? cur : ps;
  const m = ps.masks;
  const N = idx ? idx.length : ps.n;
  const get = idx ? (k) => idx[k] : (k) => k;

  const BIN = 0.1, hist = new Float64Array(1001);
  let clipHi = 0, clipLo = 0;
  let sumC = 0, lowC = 0, lowN = 0;
  const z = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let na = 0, nb = 0, nn = 0;
  const band = Array.from({ length: 8 }, () => ({ w: 0, a: 0, b: 0, c: 0, l: 0 }));
  let sa = 0, sb = 0, sc = 0, sn = 0; const skinH = []; let ha = 0, hb = 0, hc = 0, hn = 0;

  for (let k = 0; k < N; k++) {
    const i = get(k);
    const l = L[i], a = A[i], b = B[i];
    const c = Math.hypot(a, b);
    let bi = Math.round(l / BIN); if (bi < 0) bi = 0; if (bi > 1000) bi = 1000;
    hist[bi]++;
    const mx = Math.max(lin.lr[i], lin.lg[i], lin.lb[i]);
    if (mx >= 0.9955) clipHi++;
    if (mx <= 0.0006) clipLo++;
    sumC += c;
    if (m.lowSat[i]) { lowC += c; lowN++; }
    if (m.zoneTint[i]) { for (let q = 0; q < 3; q++) { const w = m.zw[i * 3 + q]; if (w) { const zz = z[q]; zz[0] += w * a; zz[1] += w * b; zz[2] += w; } } }
    if (m.neutral[i]) { na += a; nb += b; nn++; }
    const o = i * 8;
    for (let q = 0; q < 8; q++) {
      const w = m.bw[o + q];
      if (w > 0) { const bd = band[q]; bd.w += w; bd.a += w * a; bd.b += w * b; bd.c += w * c; bd.l += w * l; }
    }
    if (m.skin[i]) { sa += a; sb += b; sc += c; sn++; skinH.push(Math.atan2(b, a) * 180 / Math.PI); if (m.skin[i] === 2) { ha += a; hb += b; hc += c; hn++; } }
  }

  const pct = {};
  for (const p of PCTS) pct[p] = percentileFromHist(hist, N, p, BIN);
  const black = percentileFromHist(hist, N, 0.5, BIN);
  const white = percentileFromHist(hist, N, 99.5, BIN);

  const tone = {
    pct, black, white,
    clipHi: clipHi / N, clipLo: clipLo / N,
    exposure: pct[50],
    contrast: pct[75] - pct[25],
    highlights: pct[95] - pct[75],
    shadows: pct[25] - pct[5],
    whites: pct[99] - pct[95],
    blacks: pct[5] - pct[1],
  };
  const curve = {
    liftedBlacks: pct[1],
    crushedShadows: tone.clipLo,
    fadedTop: 100 - pct[99],
    sStrength: (pct[75] - pct[25]) / Math.max(1, pct[95] - pct[5]),
  };
  const nA = nn ? na / nn : 0, nB = nn ? nb / nn : 0;
  const wb = { a: nA, b: nB, ...labToCctDuv(60, nA, nB), confidence: ps.wbConfidence, pixels: nn / N };

  const zoneNames = ['shadows', 'midtones', 'highlights'];
  const zones = {};
  z.forEach((zz, k) => {
    const a = zz[2] ? zz[0] / zz[2] : 0, b = zz[2] ? zz[1] / zz[2] : 0;
    zones[zoneNames[k]] = { a, b, hue: abToWheelHue(a, b), sat: Math.hypot(a, b), mass: zz[2] / N };
  });

  const bands = {};
  band.forEach((bd, q) => {
    const w = bd.w / N;
    const a = bd.w ? bd.a / bd.w : 0, b = bd.w ? bd.b / bd.w : 0;
    bands[BANDS[q]] = {
      weight: w,
      hue: Math.atan2(b, a) * 180 / Math.PI,
      chroma: bd.w ? bd.c / bd.w : 0,
      lum: bd.w ? bd.l / bd.w : 0,
      lumRel: bd.w ? bd.l / bd.w - pct[50] : 0,
    };
  });

  const color = { meanChroma: sumC / N, lowChroma: lowN ? lowC / lowN : 0 };
  const sh = sn ? Math.atan2(sb / sn, sa / sn) * 180 / Math.PI : 0;
  let sv = 0; for (const h of skinH) { let d = h - sh; d = ((d + 180) % 360 + 360) % 360 - 180; sv += d * d; }
  const skin = { source: ps.skinSource, faces: ps.faceCount, frac: sn / N, hue: sh, chroma: sn ? sc / sn : 0, hueSpread: sn ? Math.sqrt(sv / sn) : 0,
    litHue: hn ? Math.atan2(hb / hn, ha / hn) * 180 / Math.PI : 0, litChroma: hn ? hc / hn : 0 };

  return { tone, curve, wb, zones, bands, color, skin };
}

// Round everything for printing / storage.
export function roundStats(s, d = 2) {
  return JSON.parse(JSON.stringify(s, (k, v) => (typeof v === 'number' ? +v.toFixed(d) : v)));
}
