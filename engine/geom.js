// Crop and level. A photo's geometry is { angle, x, y, w, h }:
//   angle  degrees, positive turns the photo clockwise (as seen on screen)
//   x,y,w,h the crop rectangle as fractions of the image width/height, measured in the frame of the
//          turned photo (same W x H frame, turned about its centre). The rectangle must stay inside
//          the turned photo.
// Everything here is plain math so the worker, the page and the Node tools share it.

export const GEOM_ID = Object.freeze({ angle: 0, x: 0, y: 0, w: 1, h: 1 });
const EPS = 1e-6;

export function isIdentityGeom(g) {
  return !g || (Math.abs(g.angle || 0) < 1e-4 && g.x < EPS && g.y < EPS && g.w > 1 - EPS && g.h > 1 - EPS);
}
export const geomKey = (g) => (isIdentityGeom(g) ? 'id' : [g.angle, g.x, g.y, g.w, g.h].map((v) => (+v).toFixed(5)).join(','));

const rad = (d) => (d * Math.PI) / 180;

// point in the turned frame (pixels) -> point in the original photo (pixels)
export function toSource(qx, qy, W, H, angle) {
  const t = rad(angle), c = Math.cos(t), s = Math.sin(t);
  const dx = qx - W / 2, dy = qy - H / 2;
  // inverse of a clockwise turn by t (y down): rotate by -t
  return [W / 2 + c * dx + s * dy, H / 2 - s * dx + c * dy];
}
// original photo (pixels) -> turned frame (pixels)
export function toTurned(sx, sy, W, H, angle) {
  const t = rad(angle), c = Math.cos(t), s = Math.sin(t);
  const dx = sx - W / 2, dy = sy - H / 2;
  return [W / 2 + c * dx - s * dy, H / 2 + s * dx + c * dy];
}

/** Is the rectangle inside the turned photo (and inside the frame)? W,H only matter through their ratio. */
export function validRect(r, W, H, angle, tol = 1e-4) {
  if (r.w <= 0 || r.h <= 0 || r.x < -tol || r.y < -tol || r.x + r.w > 1 + tol || r.y + r.h > 1 + tol) return false;
  for (const [u, v] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const [sx, sy] = toSource(u * W, v * H, W, H, angle);
    if (sx < -tol * W || sy < -tol * H || sx > W * (1 + tol) || sy > H * (1 + tol)) return false;
  }
  return true;
}

/**
 * Largest rectangle with pixel aspect `aspect` (width/height; null = the photo's own) centred on
 * (cx, cy) (fractions) that fits inside the photo turned by `angle`.
 */
export function maxRect(W, H, angle, aspect = null, cx = 0.5, cy = 0.5) {
  const a = aspect || W / H;
  // start from the centred closed form, then shrink about (cx, cy) until valid
  const t = Math.abs(rad(angle)), c = Math.cos(t), s = Math.sin(t);
  let wpx = Math.min(W / (c + s / a), H / (s + c / a), W, H * a);
  let hpx = wpx / a;
  let r = { x: cx - wpx / W / 2, y: cy - hpx / H / 2, w: wpx / W, h: hpx / H };
  if (validRect(r, W, H, angle)) return r;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    const q = { x: cx - (wpx * m) / W / 2, y: cy - (hpx * m) / H / 2, w: (wpx * m) / W, h: (hpx * m) / H };
    if (validRect(q, W, H, angle)) lo = m; else hi = m;
  }
  if (lo < 0.05 && (Math.abs(cx - 0.5) > 1e-6 || Math.abs(cy - 0.5) > 1e-6)) return maxRect(W, H, angle, aspect); // centre drifted outside: recentre
  return { x: cx - (wpx * lo) / W / 2, y: cy - (hpx * lo) / H / 2, w: (wpx * lo) / W, h: (hpx * lo) / H };
}

/** Move from rect a toward rect b as far as stays valid (the valid set is convex, so bisection is exact). */
export function towardValid(a, b, W, H, angle) {
  if (validRect(b, W, H, angle)) return b;
  let lo = 0, hi = 1;
  const mix = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (validRect(mix(m), W, H, angle)) lo = m; else hi = m; }
  return mix(lo);
}

/** Keep the crop valid after the angle changes: same centre and aspect, shrink (or recentre) as needed. */
export function fitAfterTurn(r, W, H, angle) {
  if (validRect(r, W, H, angle)) return r;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = (r.w * W) / (r.h * H);
  const m = maxRect(W, H, angle, a, cx, cy);
  if (m.w <= r.w + 1e-9) return m;
  return { x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h };
}

/** Output size in pixels for a W x H photo. */
export function geomSize(W, H, g) {
  if (isIdentityGeom(g)) return [W, H];
  return [Math.max(1, Math.round(g.w * W)), Math.max(1, Math.round(g.h * H))];
}

/**
 * Canvas transform for drawing the source photo (sw x sh pixels) so that output pixel (u, v) at
 * `scale` output pixels per source pixel shows the geometry. oy shifts down for tiles.
 * Returns [a, b, c, d, e, f] for ctx.setTransform.
 */
export function drawTransform(sw, sh, g, scale = 1, oy = 0) {
  const t = rad(g.angle || 0), c = Math.cos(t), s = Math.sin(t);
  // out = scale * (R(t) * (src - C) + C - (x*W, y*H)) - (0, oy)
  const k = scale;
  const ex = k * (-(c * sw / 2 - s * sh / 2) + sw / 2 - g.x * sw);
  const ey = k * (-(s * sw / 2 + c * sh / 2) + sh / 2 - g.y * sh) - oy;
  return [k * c, k * s, -k * s, k * c, ex, ey];
}

/** Face outlines (0..1 of the photo) -> 0..1 of the cropped output. */
export function mapPolys(polys, W, H, g) {
  if (!polys || isIdentityGeom(g)) return polys;
  return polys.map((poly) => poly.map(([u, v]) => {
    const [qx, qy] = toTurned(u * W, v * H, W, H, g.angle || 0);
    return [(qx / W - g.x) / g.w, (qy / H - g.y) / g.h];
  }));
}

/**
 * Lightroom crop fields. Lightroom stores the upper-left and lower-right corners of the crop in the
 * un-turned photo (0..1, before EXIF orientation) and CropAngle = the crop box's own turn, positive
 * clockwise, about its centre. Our angle turns the photo, so the box turns the other way.
 * orientation: EXIF orientation of the stored pixels (1, 3, 6, 8 handled).
 */
export function lightroomCrop(g, W, H, orientation = 1) {
  if (isIdentityGeom(g)) return null;
  // corners in the displayed photo, pixels
  const pts = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]].map(([u, v]) => toSource(u * W, v * H, W, H, g.angle || 0));
  // displayed pixels -> stored pixels
  const rot = orientation === 6 || orientation === 8;
  const SW = rot ? H : W, SH = rot ? W : H;
  const toStored = ([x, y]) => {
    const u = x / W, v = y / H;
    if (orientation === 3) return [(1 - u) * SW, (1 - v) * SH];
    if (orientation === 6) return [v * SW, (1 - u) * SH];
    if (orientation === 8) return [(1 - v) * SW, u * SH];
    return [u * SW, v * SH];
  };
  const sp = pts.map(toStored);
  const cropAngle = -(g.angle || 0);
  // level the box (undo its clockwise turn) to find which stored corner is its upper-left
  const cx = sp.reduce((a, p) => a + p[0], 0) / 4, cy = sp.reduce((a, p) => a + p[1], 0) / 4;
  const t = rad(-cropAngle), c = Math.cos(t), s = Math.sin(t);
  const lev = sp.map(([x, y]) => [cx + c * (x - cx) - s * (y - cy), cy + s * (x - cx) + c * (y - cy)]);
  let ul = 0, lr = 0;
  for (let i = 1; i < 4; i++) { if (lev[i][0] + lev[i][1] < lev[ul][0] + lev[ul][1]) ul = i; if (lev[i][0] + lev[i][1] > lev[lr][0] + lev[lr][1]) lr = i; }
  const f = (v) => Math.min(1, Math.max(0, v)).toFixed(6);
  return {
    HasCrop: 'True', CropTop: f(sp[ul][1] / SH), CropLeft: f(sp[ul][0] / SW), CropBottom: f(sp[lr][1] / SH), CropRight: f(sp[lr][0] / SW),
    CropAngle: (+cropAngle).toFixed(2), CropConstrainToWarp: 0,
  };
}

/**
 * Auto level: strongest near-horizontal / near-vertical edge direction within +-maxDeg.
 * gray: Float32Array (0..1) of a small image (w x h, ~512 px). Returns the clockwise turn (degrees)
 * that makes those edges level, and a confidence (0..1). Weak or split evidence -> confidence low.
 */
export function autoLevel(gray, w, h, maxDeg = 20) {
  const bins = 4 * maxDeg * 4; // 0.25 degree bins over [-maxDeg, maxDeg]... doubled for smoothing room
  const hist = new Float64Array(bins + 1);
  const step = (2 * maxDeg) / bins;
  let total = 0;
  const mags = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      mags.push(gx * gx + gy * gy);
    }
  }
  const sorted = Float64Array.from(mags).sort();
  const thr = sorted[Math.floor(sorted.length * 0.9)] || 0; // strongest 10% of edges
  if (thr <= 1e-6) return { angle: 0, confidence: 0 };
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++, k++) {
      const m2 = mags[k];
      if (m2 < thr) continue;
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      // edge direction = gradient + 90 deg; fold to the nearest axis
      let d = (Math.atan2(gy, gx) * 180) / Math.PI + 90;
      d = ((d % 90) + 90) % 90; if (d > 45) d -= 90; // -45..45 off the nearest axis
      if (Math.abs(d) > maxDeg) continue;
      const wgt = Math.sqrt(m2);
      hist[Math.round((d + maxDeg) / step)] += wgt; total += wgt;
    }
  }
  if (!total) return { angle: 0, confidence: 0 };
  // smooth (gaussian, sigma ~0.5 deg) and take the peak
  const sm = new Float64Array(hist.length), sg = 0.5 / step, R = Math.ceil(3 * sg);
  for (let i = 0; i < hist.length; i++) {
    let s = 0;
    for (let j = -R; j <= R; j++) { const q = i + j; if (q >= 0 && q < hist.length) s += hist[q] * Math.exp(-(j * j) / (2 * sg * sg)); }
    sm[i] = s;
  }
  let best = 0; for (let i = 1; i < sm.length; i++) if (sm[i] > sm[best]) best = i;
  const d = best * step - maxDeg;
  // confidence: share of edge weight within +-1 degree of the peak vs a flat spread
  let near = 0; for (let i = 0; i < hist.length; i++) if (Math.abs(i * step - maxDeg - d) <= 1) near += hist[i];
  const flat = 2 / (2 * maxDeg);
  const conf = Math.max(0, Math.min(1, (near / total - flat) / (0.5 - flat)));
  // the edges sit at +d off level (clockwise, y down), so turn the photo by -d
  return { angle: Math.round(-d * 10) / 10, confidence: conf };
}
