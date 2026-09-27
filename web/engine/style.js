// "If this photographer edited this photo": pick the photographer's published photos whose scenes
// look most like this one, and read their finished tone and colour off those. The per-image numbers
// come from tools/style_records.py (same formulas, Python) and live in style-data.js.

// Scene signature. Kept to things a grade moves least: brightness layout, what colours are in
// frame (coarse hue sectors), how much is neutral, skin, and a bright top (sky, window, ceiling).
export const SIG_FIELDS = ['p50', 'spread', 'warm', 'yellow', 'green', 'blue', 'magenta', 'neutral', 'top', 'skin'];
const SIG_SCALE = [15, 20, 0.12, 0.08, 0.12, 0.12, 0.06, 0.2, 12, 0.06];
const SIG_WEIGHT = [1.2, 0.8, 1, 0.8, 1, 1, 0.6, 0.8, 0.7, 1.4];

export const TARGET_FIELDS = ['p1', 'p99', 'chroma', 'shA', 'shB', 'midA', 'midB', 'hiA', 'hiB', 'vig', 'bw'];

const deg = (a, b) => { let h = (Math.atan2(b, a) * 180) / Math.PI; return h < 0 ? h + 360 : h; };

/** Signature of a photo from Lab planes (row-major width x height). */
export function signature(L, A, B, width, height) {
  const n = width * height;
  const Ls = Float32Array.from(L).sort();
  const q = (p) => Ls[Math.min(n - 1, Math.floor(p * (n - 1)))];
  let warm = 0, yellow = 0, green = 0, blue = 0, magenta = 0, neutral = 0, skin = 0, sumL = 0, topL = 0;
  const topRows = Math.max(1, Math.floor(height * 0.3));
  for (let i = 0; i < n; i++) {
    const l = L[i], a = A[i], b = B[i], C = Math.hypot(a, b);
    sumL += l;
    if (i < topRows * width) topL += l;
    if (C < 6) neutral++;
    if (C >= 10) {
      const h = deg(a, b);
      if (h >= 15 && h < 75) warm++; else if (h >= 75 && h < 110) yellow++; else if (h >= 110 && h < 180) green++; else if (h >= 180 && h < 300) blue++; else magenta++;
    }
    const h = deg(a, b);
    if (h > 25 && h < 70 && C > 8 && C < 45 && l > 30 && l < 85) skin++;
  }
  return [q(0.5), q(0.9) - q(0.1), warm / n, yellow / n, green / n, blue / n, magenta / n, neutral / n, topL / (topRows * width) - sumL / n, skin / n];
}

/**
 * Weighted targets from the k published photos nearest to `sig`.
 * data: { rows: [[...SIG_FIELDS, ...TARGET_FIELDS]] }. Returns null if there is no data.
 */
export function nearestTargets(data, sig, { color = true, k = null } = {}) {
  if (!data || !data.rows || data.rows.length < 8) return null;
  const S = SIG_FIELDS.length;
  const bwI = S + TARGET_FIELDS.indexOf('bw');
  let rows = data.rows.filter((r) => (color ? !r[bwI] : true));
  if (rows.length < 6) rows = data.rows;
  const d = rows.map((r) => {
    let s = 0;
    for (let j = 0; j < S; j++) { const z = (r[j] - sig[j]) / SIG_SCALE[j]; s += SIG_WEIGHT[j] * z * z; }
    return Math.sqrt(s);
  });
  const order = d.map((v, i) => i).sort((a, b) => d[a] - d[b]);
  k = k || Math.max(6, Math.min(16, Math.round(rows.length / 6)));
  const pick = order.slice(0, k);
  const sigma = Math.max(0.5, d[pick[Math.floor(k / 2)]]);
  const w = pick.map((i) => Math.exp(-(d[i] * d[i]) / (2 * sigma * sigma)));
  const out = {};
  TARGET_FIELDS.forEach((f, t) => {
    let s = 0, ws = 0;
    pick.forEach((i, m) => { const v = rows[i][S + t]; if (v != null && !Number.isNaN(v)) { s += w[m] * v; ws += w[m]; } });
    out[f] = ws ? s / ws : null;
  });
  // how alike the neighbours are about the shadow and highlight colour (low spread -> trust more)
  const spread = (fa, fb) => {
    const ia = S + TARGET_FIELDS.indexOf(fa), ib = S + TARGET_FIELDS.indexOf(fb);
    const vals = pick.map((i) => [rows[i][ia], rows[i][ib]]).filter(([a, b]) => a != null && b != null);
    if (vals.length < 3) return null;
    const ma = vals.reduce((s, v) => s + v[0], 0) / vals.length, mb = vals.reduce((s, v) => s + v[1], 0) / vals.length;
    return Math.sqrt(vals.reduce((s, v) => s + (v[0] - ma) ** 2 + (v[1] - mb) ** 2, 0) / vals.length);
  };
  out.spreadSh = spread('shA', 'shB'); out.spreadHi = spread('hiA', 'hiB');
  out.k = pick.length; out.n = rows.length; out.dist = d[pick[0]];
  // median of the whole set for context (vignette scaling)
  const vigI = S + TARGET_FIELDS.indexOf('vig');
  const vs = rows.map((r) => r[vigI]).filter((v) => v != null).sort((a, b) => a - b);
  out.vigMedian = vs.length ? vs[Math.floor(vs.length / 2)] : null;
  return out;
}

/** Medians of a photographer's published set (colour images for colour fields), for describing the look. */
export function profileSummary(data) {
  if (!data || !data.rows || !data.rows.length) return null;
  const S = SIG_FIELDS.length, T = (f) => S + TARGET_FIELDS.indexOf(f);
  const col = data.rows.filter((r) => !r[T('bw')]);
  const med = (rows, i) => { const v = rows.map((r) => r[i]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  return {
    n: data.rows.length, bw: data.rows.length - col.length,
    p50: med(data.rows, SIG_FIELDS.indexOf('p50')), p1: med(data.rows, T('p1')), p99: med(data.rows, T('p99')), chroma: med(col, T('chroma')),
    sh: [med(col, T('shA')), med(col, T('shB'))], mid: [med(col, T('midA')), med(col, T('midB'))], hi: [med(col, T('hiA')), med(col, T('hiB'))],
    vig: med(data.rows, T('vig')),
  };
}
