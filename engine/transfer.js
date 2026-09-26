// Color transfer: reshape this photo's color distribution into the reference's, no sliders involved.
//
//   1. histogram match each channel to the reference (1-D quantile mapping)
//   2. Monge-Kantorovich linear map (Pitié & Kokaram 2007): the closed-form linear transform that moves
//      one Gaussian (mean + 3x3 covariance) onto another with the least total color change
//   3. histogram match again, to put back the per-channel shape the linear step can't reach
//
// This is the HM-MKL-HM compound described by Hahne & Aggoun (PlenoptiCam, IEEE TIP 2021), written here
// from the published math. Works on gamma-encoded sRGB in [0,1]. Every step is a per-pixel function of
// RGB, so the whole transform bakes exactly into the same 3-D LUT the slider pipeline uses.

import { SRGB8_TO_LIN, linearToSrgb, linToLab } from './color.js';

export const Q = 256; // quantile table has Q+1 entries

// ---- small 3x3 helpers ---------------------------------------------------------------------
function mat3mul(A, B) {
  const C = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
}
// symmetric eigen decomposition (cyclic Jacobi). Returns { val[3], vec (columns) }
function eigSym(S) {
  const a = Float64Array.from(S);
  const v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // rotate columns p,q of a
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // rotate rows p,q
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq; v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { val: [a[0], a[4], a[8]], vec: v };
}
// f(S) for symmetric S via eigen: V diag(f(l)) V^T
function symFn(S, f) {
  const { val, vec } = eigSym(S);
  const D = val.map((l) => f(Math.max(l, 0)));
  const M = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += vec[i * 3 + k] * D[k] * vec[j * 3 + k];
    M[i * 3 + j] = s;
  }
  return M;
}

/** Monge-Kantorovich linear map from covariance Cs onto Cr: T = Cs^-1/2 (Cs^1/2 Cr Cs^1/2)^1/2 Cs^-1/2 */
export function mklMatrix(Cs, Cr) {
  const eps = 1e-7;
  const Sh = symFn(Cs, (l) => Math.sqrt(l + eps));
  const Sih = symFn(Cs, (l) => 1 / Math.sqrt(l + eps));
  const Mid = symFn(mat3mul(mat3mul(Sh, Cr), Sh), Math.sqrt);
  return mat3mul(mat3mul(Sih, Mid), Sih);
}

// ---- stats ---------------------------------------------------------------------------------
function quantilesOf(vals) {
  const s = Float32Array.from(vals).sort();
  const q = new Float32Array(Q + 1);
  const n = s.length;
  for (let k = 0; k <= Q; k++) {
    const f = (k / Q) * (n - 1), i = Math.floor(f), t = f - i;
    q[k] = i + 1 < n ? s[i] + (s[i + 1] - s[i]) * t : s[n - 1];
  }
  return q;
}

function meanCov(R, G, B) {
  const n = R.length;
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i++) { mr += R[i]; mg += G[i]; mb += B[i]; }
  mr /= n; mg /= n; mb /= n;
  let rr = 0, rg = 0, rb = 0, gg = 0, gb = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    const r = R[i] - mr, g = G[i] - mg, b = B[i] - mb;
    rr += r * r; rg += r * g; rb += r * b; gg += g * g; gb += g * b; bb += b * b;
  }
  const d = Math.max(1, n - 1);
  return { mean: [mr, mg, mb], cov: [rr / d, rg / d, rb / d, rg / d, gg / d, gb / d, rb / d, gb / d, bb / d] };
}

/** Channels of an 8-bit image as gamma floats in [0,1]. */
export function channels(img) {
  const ch = img.channels || 4, n = img.width * img.height;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += ch) { R[i] = img.data[j] / 255; G[i] = img.data[j + 1] / 255; B[i] = img.data[j + 2] / 255; }
  return [R, G, B];
}

/** What a preset keeps for transfer: 3 quantile tables + mean + covariance (about 800 numbers). */
export function transferStats(img) {
  const [R, G, B] = channels(img);
  const { mean, cov } = meanCov(R, G, B);
  return { q: [quantilesOf(R), quantilesOf(G), quantilesOf(B)].map((a) => Array.from(a, (v) => +v.toFixed(5))), mean, cov };
}

// ---- 1-D quantile mapping --------------------------------------------------------------------
// Piecewise-linear map through (srcQ[k], refQ[k]). Flat runs in srcQ (many pixels at one value, e.g. clipped
// sky) map to the middle of the matching refQ run. Outside the source range the ends extend with slope 1.
function qmapper(srcQ, refQ) {
  const xs = [], ys = [];
  for (let k = 0; k <= Q;) {
    let e = k;
    while (e + 1 <= Q && srcQ[e + 1] - srcQ[k] < 1e-6) e++;
    xs.push(srcQ[k]);
    ys.push(e > k ? (refQ[k] + refQ[e]) / 2 : refQ[k]);
    k = e + 1;
  }
  const n = xs.length;
  return function (x) {
    if (n === 1) return ys[0] + (x - xs[0]);
    if (x <= xs[0]) return ys[0] + (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
  };
}

// ---- fit ----------------------------------------------------------------------------------------
/**
 * Fit the transform for one photo (use the ~512 px preview). ref = transferStats of the reference.
 * method: 'hm-mkl-hm' (default), 'mkl', 'hm', 'reinhard' (steps joined by '-', run left to right).
 * Returns fn(r,g,b,out) on gamma [0,1] values, already blended by strength.
 */
export function fitTransfer(img, ref, { method = 'hm-mkl-hm', strength = 1 } = {}) {
  let [R, G, B] = channels(img);
  const n = R.length;
  const steps = [];
  const refQ = ref.q.map((a) => Float32Array.from(a));

  const hmStep = () => {
    const maps = [R, G, B].map((C, c) => qmapper(quantilesOf(C), refQ[c]));
    steps.push((v) => { v[0] = maps[0](v[0]); v[1] = maps[1](v[1]); v[2] = maps[2](v[2]); });
    const R2 = new Float32Array(n), G2 = new Float32Array(n), B2 = new Float32Array(n);
    for (let i = 0; i < n; i++) { R2[i] = maps[0](R[i]); G2[i] = maps[1](G[i]); B2[i] = maps[2](B[i]); }
    R = R2; G = G2; B = B2;
  };
  const linStep = (T, ms, mr) => {
    steps.push((v) => {
      const r = v[0] - ms[0], g = v[1] - ms[1], b = v[2] - ms[2];
      v[0] = T[0] * r + T[1] * g + T[2] * b + mr[0];
      v[1] = T[3] * r + T[4] * g + T[5] * b + mr[1];
      v[2] = T[6] * r + T[7] * g + T[8] * b + mr[2];
    });
    const R2 = new Float32Array(n), G2 = new Float32Array(n), B2 = new Float32Array(n);
    const v = [0, 0, 0];
    for (let i = 0; i < n; i++) { v[0] = R[i]; v[1] = G[i]; v[2] = B[i]; steps[steps.length - 1](v); R2[i] = v[0]; G2[i] = v[1]; B2[i] = v[2]; }
    R = R2; G = G2; B = B2;
  };
  const mklStep = () => { const s = meanCov(R, G, B); linStep(mklMatrix(s.cov, ref.cov), s.mean, ref.mean); };
  const reinhardStep = () => { // per-channel mean/std only (no cross-channel terms)
    const s = meanCov(R, G, B);
    const T = [Math.sqrt(ref.cov[0] / Math.max(1e-9, s.cov[0])), 0, 0, 0, Math.sqrt(ref.cov[4] / Math.max(1e-9, s.cov[4])), 0, 0, 0, Math.sqrt(ref.cov[8] / Math.max(1e-9, s.cov[8]))];
    linStep(T, s.mean, ref.mean);
  };

  for (const part of method.split('-')) {
    if (part === 'hm') hmStep();
    else if (part === 'mkl') mklStep();
    else if (part === 'reinhard') reinhardStep();
    else throw new Error('unknown transfer step ' + part);
  }

  const s = Math.max(0, Math.min(1, strength));
  const v = [0, 0, 0];
  return function (r, g, b, out) {
    v[0] = r; v[1] = g; v[2] = b;
    for (const f of steps) f(v);
    for (let c = 0; c < 3; c++) {
      const x = c === 0 ? r : c === 1 ? g : b;
      const y = x + s * (v[c] - x);
      out[c] = y < 0 ? 0 : y > 1 ? 1 : y;
    }
    return out;
  };
}

/** Bake a fitted transform into a LUT usable by pipeline.applyLUT. */
export function transferLUT(fn, N = 65) {
  const data = new Float32Array(N * N * N * 3);
  const out = [0, 0, 0];
  let o = 0;
  for (let ib = 0; ib < N; ib++) for (let ig = 0; ig < N; ig++) for (let ir = 0; ir < N; ir++) {
    fn(ir / (N - 1), ig / (N - 1), ib / (N - 1), out);
    data[o++] = out[0]; data[o++] = out[1]; data[o++] = out[2];
  }
  return { N, data };
}

/** Steepest point of the transform along the grey axis (same meaning as the slider pipeline's banding check). */
export function transferSlope(fn) {
  const a = [0, 0, 0], b = [0, 0, 0];
  let mx = 0;
  const h = 1 / 64;
  for (let x = 0.02; x + h <= 0.98; x += h / 2) {
    fn(x, x, x, a); fn(x + h, x + h, x + h, b);
    const ya = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    const yb = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2];
    mx = Math.max(mx, (yb - ya) / h);
  }
  return mx;
}

/** Run the transform on a PixelSet (from measure.prepare) so the usual measurements and loss checks work. */
export function transferPixelSet(ps, fn, cur) {
  const n = ps.n;
  cur = cur || { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), lr: new Float32Array(n), lg: new Float32Array(n), lb: new Float32Array(n) };
  const out = [0, 0, 0], lab = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    fn(linearToSrgb(ps.lr[i]), linearToSrgb(ps.lg[i]), linearToSrgb(ps.lb[i]), out);
    // quantize like an 8-bit output would be
    const r = SRGB8_TO_LIN[Math.round(out[0] * 255)], g = SRGB8_TO_LIN[Math.round(out[1] * 255)], b = SRGB8_TO_LIN[Math.round(out[2] * 255)];
    cur.lr[i] = r; cur.lg[i] = g; cur.lb[i] = b;
    linToLab(r, g, b, lab);
    cur.L[i] = lab[0]; cur.A[i] = lab[1]; cur.B[i] = lab[2];
  }
  return cur;
}
