// Subject masks with MediaPipe (Apache-2.0). Runs inside the engine worker.
//   people:    Selfie Multiclass (background / hair / body skin / face skin / clothes / other). Person = not background.
//   anything:  Magic Touch, the object under a tap (added to or taken out of the subject).
// Masks live at MASK_SIDE on the long side, in the coordinates of the whole, uncropped photo, and are
// refined against the photo's own edges with a guided filter so hair and shoulders follow the image.
import { ImageSegmenter, InteractiveSegmenterLegacy } from './vendor/mediapipe/vision_bundle.mjs';
import { lazyTask } from './mp.js';
import { fuseCropProbabilities, personProbabilities } from './engine/mask-refine.js';

export const MASK_SIDE = 1024;
const MODEL_SIDE = 512; // what the models are fed (they resample to 256 / 512 themselves)

export const segmenter = lazyTask('person', ImageSegmenter, {
  baseOptions: { modelAssetPath: new URL('./models/selfie_multiclass_256x256.tflite', import.meta.url).href, delegate: 'CPU' },
  runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
});
const tapper = lazyTask('tap', InteractiveSegmenterLegacy, {
  baseOptions: { modelAssetPath: new URL('./models/magic_touch.tflite', import.meta.url).href, delegate: 'CPU' },
  outputConfidenceMasks: true, outputCategoryMask: false,
});

// ---------------------------------------------------------------- image helpers
function draw(src, sx, sy, sw, sh, dw, dh) {
  const c = new OffscreenCanvas(dw, dh);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return x.getImageData(0, 0, dw, dh);
}

/** Luminance guide (0..1) of an RGBA ImageData. */
function lumaOf(d) {
  const n = d.width * d.height, g = new Float32Array(n), a = d.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (0.299 * a[j] + 0.587 * a[j + 1] + 0.114 * a[j + 2]) / 255;
  return g;
}

// bilinear resample of a float plane
function resample(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const kx = sw / dw, ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ky - 0.5)), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * kx - 0.5)), x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const b = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = a + (b - a) * ty;
    }
  }
  return out;
}

// box mean with radius r (separable running sums, edges normalised by the true window size)
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r - 1, hi = x + r;
      if (x > 0) { if (hi < w) s += src[o + hi]; if (lo >= 0) s -= src[o + lo]; }
      tmp[o + x] = s / (Math.min(w - 1, hi) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y - r - 1, hi = y + r;
      if (y > 0) { if (hi < h) s += tmp[hi * w + x]; if (lo >= 0) s -= tmp[lo * w + x]; }
      out[y * w + x] = s / (Math.min(h - 1, hi) - Math.max(0, y - r) + 1);
    }
  }
  return out;
}

/** Guided filter (He et al.): output follows the edges of guide I. */
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const II = new Float32Array(n), Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mII = boxMean(II, w, h, r), mIp = boxMean(Ip, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i], c = mIp[i] - mI[i] * mp[i];
    a[i] = c / (v + eps); b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

// low-res probability -> refined 0..255 mask at the guide's size
function refine(prob, pw, ph, guide, w, h) {
  const up = resample(prob, pw, ph, w, h);
  const r1 = Math.max(3, Math.round(Math.max(w, h) / 100)); // ~10 px at 1024
  let q = guidedFilter(guide, up, w, h, r1, 1e-3);
  q = guidedFilter(guide, q, w, h, Math.max(2, Math.round(r1 / 3)), 2e-4);
  const m = new Uint8Array(w * h);
  // stretch so confident areas are solid and the soft edge is where the model was unsure
  for (let i = 0; i < m.length; i++) { const v = (q[i] - 0.3) / 0.4; m[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
  return m;
}

// person = not background; skin = body skin + face skin (Selfie Multiclass categories 2 and 3)
function personProb(seg, img) {
  const r = seg.segment(img);
  try {
    const cm = r.confidenceMasks;
    const width = cm[0].width || img.width, height = cm[0].height || img.height;
    const hair = cm[1] && cm[1].getAsFloat32Array();
    const body = cm[2] && cm[2].getAsFloat32Array(), face = cm[3] && cm[3].getAsFloat32Array();
    const clothes = cm[4] && cm[4].getAsFloat32Array();
    // Model classes: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 accessories.
    // Accessories contribute only beside supported person classes, so hats/glasses stay attached.
    const accessories = cm[5] && cm[5].getAsFloat32Array();
    const { foreground: p, skin: sk } = personProbabilities({ hair, body, face, clothes, accessories, width, height });
    return { p, sk, width, height };
  } finally { r.close(); }
}

/** Working-size RGBA + guide for a photo bitmap. */
export function maskCanvasSize(W, H) {
  const s = Math.min(1, MASK_SIDE / Math.max(W, H));
  return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))];
}

/**
 * People in the photo. bmp: ImageBitmap/canvas of the whole photo.
 * Returns { w, h, data: Uint8Array (0..255), frac, skin: Uint8Array (0..255 facial + body skin), skinFrac } or null when the model failed; data is all zeros when nobody is there.
 */
export async function personMask(bmp) {
  const seg = await segmenter();
  if (!seg) return null;
  const W = bmp.width, H = bmp.height;
  const [w, h] = maskCanvasSize(W, H);
  const full = draw(bmp, 0, 0, W, H, w, h);
  const guide = lumaOf(full);
  // pass 1: whole frame
  const s1 = Math.min(1, MODEL_SIDE / Math.max(W, H));
  const pw = Math.max(1, Math.round(W * s1)), ph = Math.max(1, Math.round(H * s1));
  const p1 = personProb(seg, draw(bmp, 0, 0, W, H, pw, ph));
  let prob = resample(p1.p, p1.width, p1.height, w, h), skin = resample(p1.sk, p1.width, p1.height, w, h);
  // bounding box of what was found
  let x0 = w, y0 = h, x1 = -1, y1 = -1, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (prob[y * w + x] > 0.5) { cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const frac0 = cnt / (w * h);
  if (frac0 < 0.002) return { w, h, data: new Uint8Array(w * h), frac: 0, skin: new Uint8Array(w * h), skinFrac: 0 };
  // pass 2: people small in the frame (full-length, groups) get a closer look at the model's resolution
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if ((bw * bh) / (w * h) < 0.45) {
    const pad = 0.18 * Math.max(bw, bh);
    const cx0 = Math.max(0, Math.floor(x0 - pad)), cy0 = Math.max(0, Math.floor(y0 - pad));
    const cx1 = Math.min(w, Math.ceil(x1 + 1 + pad)), cy1 = Math.min(h, Math.ceil(y1 + 1 + pad));
    const cw = cx1 - cx0, chh = cy1 - cy0;
    const k = W / w; // working px -> photo px
    const s2 = Math.min(1, MODEL_SIDE / Math.max(cw * k, chh * k));
    const qw = Math.max(1, Math.round(cw * k * s2)), qh = Math.max(1, Math.round(chh * k * s2));
    const q2 = personProb(seg, draw(bmp, cx0 * k, cy0 * k, cw * k, chh * k, qw, qh));
    const p2 = resample(q2.p, q2.width, q2.height, cw, chh), sk2 = resample(q2.sk, q2.width, q2.height, cw, chh);
    // Let the close pass refine/extend the full-frame silhouette locally. It cannot create a
    // crop-shaped foreground patch where the full-frame pass found no person evidence.
    const fade = Math.max(2, Math.round(0.08 * Math.min(cw, chh)));
    const supportRadius = Math.max(3, Math.round(Math.min(cw, chh) * 0.02));
    fuseCropProbabilities(prob, p2, w, h, { x0: cx0, y0: cy0, cropWidth: cw, cropHeight: chh, fade, supportRadius });
    // Skin classes only sharpen skin already supported by the full-frame person probability.
    const skinSupport = new Uint8Array(w * h);
    for (let i = 0; i < skin.length; i++) skinSupport[i] = prob[i] >= 0.2 ? 1 : 0;
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
      const i = (cy0 + y) * w + cx0 + x;
      if (!skinSupport[i]) continue;
      const edge = Math.min(cx0 > 0 ? x : 1e9, cy0 > 0 ? y : 1e9, cx1 < w ? cw - 1 - x : 1e9, cy1 < h ? chh - 1 - y : 1e9);
      const t = Math.min(1, edge / fade), j = y * cw + x;
      skin[i] += (sk2[j] - skin[i]) * t;
    }
  }
  const data = refine(prob, w, h, guide, w, h);
  let on = 0; for (let i = 0; i < data.length; i++) on += data[i];
  // skin: same edge refinement, then kept inside the person (the skin classes bleed onto warm backgrounds)
  const sk = refine(skin, w, h, guide, w, h);
  let son = 0; for (let i = 0; i < sk.length; i++) { sk[i] = (sk[i] * data[i]) / 255; son += sk[i]; }
  return { w, h, data, frac: on / 255 / data.length, skin: sk, skinFrac: son / 255 / sk.length };
}

/**
 * The object under (x, y) (0..1 of the whole photo). Returns { w, h, data } at the working size or null.
 */
export async function tapMask(bmp, x, y) {
  const tap = await tapper();
  if (!tap) return null;
  const W = bmp.width, H = bmp.height;
  const [w, h] = maskCanvasSize(W, H);
  const s = Math.min(1, MODEL_SIDE / Math.max(W, H));
  const pw = Math.max(1, Math.round(W * s)), ph = Math.max(1, Math.round(H * s));
  const r = tap.segment(draw(bmp, 0, 0, W, H, pw, ph), { keypoint: { x, y } });
  let prob;
  try {
    const m = r.confidenceMasks && r.confidenceMasks[0];
    if (!m) return null;
    prob = Float32Array.from(m.getAsFloat32Array());
    const mw = m.width, mh = m.height;
    const guide = lumaOf(draw(bmp, 0, 0, W, H, w, h));
    return { w, h, data: refine(prob, mw, mh, guide, w, h) };
  } finally { r.close(); }
}
