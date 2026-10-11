// Local masks for dynamic looks, placed on each photo instead of copied from the example's pixels.
// A spec says what the photographer masked (a gradient from an edge, a radial on the light, the sky,
// skin, irises) and the local adjustments; this module turns it into a 0..255 plane over the whole,
// uncropped photo. Placement comes from simple, explainable measurements on a small copy of the
// photo, so the same spec lands sensibly on a different scene:
//   light  - the brightest broad area outside people, after heavy blurring (sun or window side)
//   sky    - smooth, bright or blue areas grown down from the top edge, people excluded
//   subject- the people mask's weighted centre and spread
// These are heuristics, not scene understanding: a white wall can read as the light, a pale ceiling
// as sky. The detail view says where each mask was placed.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0; const o = y * w;
    for (let x = -r; x <= r; x++) s += src[o + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / (2 * r + 1);
      s += src[o + clamp(x + r + 1, 0, w - 1)] - src[o + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

/** Guided filter (He et al. 2010): q follows the edges of guide I. */
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h, II = new Float32Array(n), Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
  const mI = boxBlur(I, w, h, r), mp = boxBlur(p, w, h, r), mII = boxBlur(II, w, h, r), mIp = boxBlur(Ip, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = boxBlur(a, w, h, r), mb = boxBlur(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/** Bilinear resample of a float plane to dw x dh, as 0..255 bytes. */
export function resamplePlane(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = clamp((y + 0.5) * sh / dh - 0.5, 0, sh - 1), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = clamp((x + 0.5) * sw / dw - 0.5, 0, sw - 1), x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const b = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = clamp(Math.round(a + (b - a) * ty), 0, 255);
    }
  }
  return out;
}

/** Nearest-neighbour sample of a w x h byte plane at small-image resolution sw x sh. */
function downPlane(plane, w, h, sw, sh) {
  const out = new Uint8Array(sw * sh);
  if (!plane) return out;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) out[y * sw + x] = plane[Math.min(h - 1, (y * h / sh) | 0) * w + Math.min(w - 1, (x * w / sw) | 0)];
  return out;
}

function lumaPlane(rgba, n) {
  const L = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
  return L;
}

/**
 * Where the light comes from, in 0..1 of the photo. small: { width, height, data (RGBA) }.
 * person: 0..255 plane at small size (or null). Returns { x, y, strength } where strength is how much
 * brighter that area is than the photo's median (0 = flat light, no clear source).
 */
export function estimateLight(small, person = null) {
  const { width: w, height: h, data } = small, n = w * h;
  const L = lumaPlane(data, n);
  // people are what's lit, not the light: replace them with the photo's median so they don't win
  const sorted = Float32Array.from(L).sort(), med = sorted[n >> 1];
  if (person) for (let i = 0; i < n; i++) if (person[i] > 96) L[i] = med;
  const r = Math.max(2, Math.round(Math.max(w, h) / 10));
  const B = boxBlur(boxBlur(L, w, h, r), w, h, r);
  // light from above is more likely than from below: a mild preference for the upper frame
  let best = -1, bi = 0, top = 0;
  for (let i = 0; i < n; i++) { const v = B[i] * (1.1 - 0.2 * ((i / w) | 0) / h); if (v > top) { top = v; best = B[i]; bi = i; } }
  const strength = clamp((best - med) / Math.max(0.05, best), 0, 1);
  // flat light has no side: fall back to high centre, where a glow reads as overhead light
  if (strength < 0.1) return { x: 0.5, y: 0.2, strength };
  return { x: (bi % w + 0.5) / w, y: (((bi / w) | 0) + 0.5) / h, strength };
}

/** The people mask's weighted centre and half-extent in 0..1, or null when nobody was found. */
export function subjectBox(person, w, h) {
  if (!person) return null;
  let s = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = person[y * w + x]; if (v > 96) { s += v; sx += v * x; sy += v * y; } }
  if (s < 255 * w * h * 0.005) return null;
  const cx = sx / s, cy = sy / s;
  let vx = 0, vy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = person[y * w + x]; if (v > 96) { vx += v * (x - cx) ** 2; vy += v * (y - cy) ** 2; } }
  return { x: (cx + 0.5) / w, y: (cy + 0.5) / h, sx: 2 * Math.sqrt(vx / s) / w, sy: 2 * Math.sqrt(vy / s) / h };
}

/**
 * Sky as a 0..1 float plane at small size: pixels that are smooth (little local detail), bright or
 * blue-dominant, not people, and connected to the top edge through similar neighbours. Less than 2%
 * of the frame counts as no sky.
 */
export function detectSky(small, person = null) {
  const { width: w, height: h, data } = small, n = w * h;
  const L = lumaPlane(data, n);
  const mean = boxBlur(L, w, h, 1), sq = boxBlur(L.map((v) => v * v), w, h, 1);
  const cand = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const detail = Math.sqrt(Math.max(0, sq[i] - mean[i] * mean[i]));
    const blue = b > r + 8 && b >= g - 6 && L[i] > 0.25;
    const bright = L[i] > 0.42; // pale, white, or sunset-coloured sky and its clouds
    cand[i] = (blue || bright) && detail < (blue ? 0.08 : 0.06) && !(person && person[i] > 96) ? 1 : 0;
  }
  const sky = new Uint8Array(n), queue = new Int32Array(n);
  let qh = 0, qt = 0;
  // seeds: the top 4% of rows (scans often carry a thin border on the first line)
  for (let i = 0; i < w * Math.max(1, Math.round(h * 0.04)); i++) if (cand[i]) { sky[i] = 1; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], x = i % w, y = (i / w) | 0;
    const j0 = i * 4;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = ny * w + nx;
      if (sky[k] || !cand[k]) continue;
      const j1 = k * 4;
      const d = Math.abs(data[j1] - data[j0]) + Math.abs(data[j1 + 1] - data[j0 + 1]) + Math.abs(data[j1 + 2] - data[j0 + 2]);
      if (d > 36) continue;
      sky[k] = 1; queue[qt++] = k;
    }
  }
  if (qt < n * 0.02) return new Float32Array(n);
  const soft = boxBlur(Float32Array.from(sky), w, h, 1);
  if (person) for (let i = 0; i < n; i++) soft[i] *= 1 - person[i] / 255;
  return soft;
}

/**
 * The plane (0..255, w x h, whole uncropped photo) for one mask spec.
 * ctx: { small: {width,height,data}, person, skin (w x h planes or null), guide (w x h luminance 0..1), faces ([poly with .eyes]),
 *        light, sky (cached results of estimateLight / detectSky, optional) }
 * Returns { plane, placed: { x, y } | null, frac }.
 */
export function buildMaskPlane(spec, w, h, ctx) {
  const plane = new Uint8Array(w * h), long = Math.max(w, h);
  let placed = null;
  if (spec.kind === 'all') plane.fill(255);
  else if (spec.kind === 'skin') { if (ctx.skin) plane.set(ctx.skin); }
  else if (spec.kind === 'linear') {
    const e = Math.max(0.01, spec.extent || 0.3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      const t = { top: v, bottom: 1 - v, left: u, right: 1 - u, topLeft: (u + v) / 2, topRight: (1 - u + v) / 2, bottomLeft: (u + 1 - v) / 2, bottomRight: (2 - u - v) / 2 }[spec.from] ?? 1;
      plane[y * w + x] = Math.round(255 * (1 - smoothstep(0, 1, t / e)));
    }
  } else if (spec.kind === 'radial') {
    let cx = spec.x ?? 0.5, cy = spec.y ?? 0.5, rx = spec.rx ?? 0.3, ry = spec.ry ?? 0.3;
    if (spec.anchor === 'light') {
      const lt = ctx.light || (ctx.small ? estimateLight(ctx.small, ctx.small && downPlane(ctx.person, w, h, ctx.small.width, ctx.small.height)) : null);
      if (lt) { cx = lt.x; cy = lt.y; }
    } else if (spec.anchor === 'subject') {
      const sb = ctx.person ? subjectBox(ctx.person, w, h) : null;
      if (sb) { cx = sb.x; cy = sb.y; rx = Math.max(rx * 0.5, sb.sx * w / long * 1.4); ry = Math.max(ry * 0.5, sb.sy * h / long * 1.4); }
    }
    placed = { x: cx, y: cy };
    const f = clamp(spec.feather ?? 0.5, 0.01, 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx * w) / (rx * long), dy = (y + 0.5 - cy * h) / (ry * long);
      plane[y * w + x] = Math.round(255 * (1 - smoothstep(1 - f, 1, Math.sqrt(dx * dx + dy * dy))));
    }
  } else if (spec.kind === 'sky') {
    if (ctx.small) {
      const sw = ctx.small.width, sh = ctx.small.height;
      const sky = ctx.sky || detectSky(ctx.small, downPlane(ctx.person, w, h, sw, sh));
      const up = resamplePlane(sky.map((v) => v * 255), sw, sh, w, h);
      if (ctx.guide) {
        // snap the soft low-res edge to the photo's own edges (roof lines, trees, cloud tops)
        const r1 = Math.max(3, Math.round(long / 100));
        let q = guidedFilter(ctx.guide, Float32Array.from(up, (v) => v / 255), w, h, r1, 1e-3);
        q = guidedFilter(ctx.guide, q, w, h, Math.max(2, Math.round(r1 / 3)), 2e-4);
        for (let i = 0; i < plane.length; i++) { const v = (q[i] - 0.25) / 0.5; plane[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
        if (ctx.person) for (let i = 0; i < plane.length; i++) plane[i] = Math.round(plane[i] * (1 - ctx.person[i] / 255));
      } else plane.set(up);
    }
  } else if (spec.kind === 'eyes') {
    for (const face of ctx.faces || []) for (const [ex, ey, er] of face.eyes || []) {
      const R = Math.max(1.5, er * w * 1.15), x0 = Math.max(0, Math.floor(ex * w - R - 1)), x1 = Math.min(w - 1, Math.ceil(ex * w + R + 1));
      const y0 = Math.max(0, Math.floor(ey * h - R - 1)), y1 = Math.min(h - 1, Math.ceil(ey * h + R + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - ex * w, y + 0.5 - ey * h) / R;
        const v = Math.round(255 * (1 - smoothstep(0.7, 1, d)));
        if (v > plane[y * w + x]) plane[y * w + x] = v;
      }
    }
  }
  let s = 0; for (let i = 0; i < plane.length; i++) s += plane[i];
  return { plane, placed, frac: s / 255 / plane.length };
}

/** Geometry only (adjustments don't move a mask), so planes can be cached across slider changes. */
export function maskSpecKey(specs) { return JSON.stringify((specs || []).map(({ adj, ...g }) => g)); }
