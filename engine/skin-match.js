import { linToLab, labToLin, linearToSrgb, SRGB8_TO_LIN } from './color.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeL = (L) => smooth(12, 30, L) * (1 - smooth(80, 95, L));

function arrays(ps, cur) {
  return {
    L: cur?.L || ps?.L, a: cur?.A || cur?.a || ps?.A || ps?.a,
    b: cur?.B || cur?.b || ps?.B || ps?.b,
  };
}

function median(values) {
  if (!values.length) return NaN;
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length & 1 ? values[m] : (values[m - 1] + values[m]) / 2;
}

export function skinStats(ps, cur = ps, idx = null) {
  const mask = ps?.skinMask, v = arrays(ps, cur);
  if (!mask || !v.L || !v.a || !v.b) return null;
  const ls = [], as = [], bs = [];
  const add = (i) => {
    if (i >= 0 && i < mask.length && mask[i] >= 191 && Number.isFinite(v.L[i]) && Number.isFinite(v.a[i]) && Number.isFinite(v.b[i])) {
      ls.push(v.L[i]); as.push(v.a[i]); bs.push(v.b[i]);
    }
  };
  if (idx) for (const i of idx) add(i); else for (let i = 0; i < mask.length; i++) add(i);
  if (ls.length < 20) return null;
  return { L: median(ls), a: median(as), b: median(bs), pixels: ls.length };
}

function inGamut(rgb) { return rgb.every((x) => Number.isFinite(x) && x >= -1e-8 && x <= 1 + 1e-8); }

export function applySkinMatchLinear(res, p, maskValue) {
  const m = clamp(Number(maskValue) || 0, 0, 255) / 255;
  const match = p?.skinMatch;
  if (!m || !match) return res;
  if (!(match.deltaL || match.deltaA || match.deltaB)) return res;
  const lab = [0, 0, 0];
  linToLab(res[0], res[1], res[2], lab);
  const weight = m * easeL(lab[0]);
  const L = clamp(lab[0] + clamp(match.deltaL || 0, -12, 12) * weight, 0, 100);
  const a = lab[1] + clamp(match.deltaA || 0, -10, 10) * weight;
  const b = lab[2] + clamp(match.deltaB || 0, -12, 12) * weight;
  let rgb = labToLin(L, a, b, [0, 0, 0]);
  if (!inGamut(rgb)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const test = labToLin(L, a * mid, b * mid, [0, 0, 0]);
      if (inGamut(test)) lo = mid; else hi = mid;
    }
    rgb = labToLin(L, a * lo, b * lo, [0, 0, 0]);
  }
  res[0] = clamp(rgb[0], 0, 1); res[1] = clamp(rgb[1], 0, 1); res[2] = clamp(rgb[2], 0, 1);
  linToLab(res[0], res[1], res[2], lab);
  res[3] = lab[0]; res[4] = lab[1]; res[5] = lab[2];
  return res;
}

export function applySkinMatchRGBA(buf, match, mask, ch = 4) {
  if (!mask || !match) return buf;
  const p = { skinMatch: match };
  for (let i = 0, j = 0; i < mask.length; i++, j += ch) {
    const res = [SRGB8_TO_LIN[buf[j]], SRGB8_TO_LIN[buf[j + 1]], SRGB8_TO_LIN[buf[j + 2]], 0, 0, 0];
    applySkinMatchLinear(res, p, mask[i]);
    // linear -> sRGB, kept local to avoid adding another public dependency surface.
    buf[j] = Math.round(linearToSrgb(res[0]) * 255); buf[j + 1] = Math.round(linearToSrgb(res[1]) * 255); buf[j + 2] = Math.round(linearToSrgb(res[2]) * 255);
  }
  return buf;
}

export function fitSkinMatch(ps, cur, target, { move = 0.65 } = {}) {
  const before = skinStats(ps, cur);
  if (!before || !target || (target.pixels != null && target.pixels < 20) || !['L', 'a', 'b'].every((k) => Number.isFinite(target[k])) || !Number.isFinite(move)) return null;
  const m = clamp(move, 0, 1);
  const v = arrays(ps, cur), limits = { L: 12, a: 10, b: 12 };
  const idx = [];
  for (let i = 0; i < ps.skinMask.length; i++) if (ps.skinMask[i] >= 191 && Number.isFinite(v.L[i]) && Number.isFinite(v.a[i]) && Number.isFinite(v.b[i])) idx.push(i);
  const delta = { L: 0, a: 0, b: 0 };
  // Estimate the median result after easing, then correct the remaining gap a few times.
  // This avoids under-fitting shadowed skin where the pixel operation intentionally eases off.
  for (let iteration = 0; iteration < 4 && m > 0; iteration++) {
    const got = {
      L: median(idx.map((i) => clamp(v.L[i] + delta.L * easeL(v.L[i]), 0, 100))),
      a: median(idx.map((i) => v.a[i] + delta.a * easeL(v.L[i]))),
      b: median(idx.map((i) => v.b[i] + delta.b * easeL(v.L[i]))),
    };
    for (const k of ['L', 'a', 'b']) delta[k] = clamp(delta[k] + (before[k] + (target[k] - before[k]) * m - got[k]), -limits[k], limits[k]);
  }
  const out = { deltaL: delta.L, deltaA: delta.a, deltaB: delta.b, target: { L: target.L, a: target.a, b: target.b }, before };
  return out;
}
