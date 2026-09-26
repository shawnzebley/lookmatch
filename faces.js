// Face outlines with MediaPipe Face Landmarker (Apache-2.0). Runs inside the engine worker.
// The model is tuned for faces that fill a good part of the frame, so when the whole-image pass finds
// nothing, it retries on overlapping zoomed-in tiles to catch small faces in full-body and group shots.
import { FilesetResolver, FaceLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

// face silhouette, in order around the face (MediaPipe face mesh indices)
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

let lmP = null;
function landmarker() {
  if (!lmP) {
    lmP = (async () => {
      const files = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', import.meta.url).href, true);
      return FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: new URL('./models/face_landmarker.task', import.meta.url).href, delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 8, minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.45,
      });
    })().catch((e) => { console.warn('face model unavailable:', e); return null; });
  }
  return lmP;
}

function draw(src, sx, sy, sw, sh, dw, dh) {
  const c = new OffscreenCanvas(dw, dh);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return x.getImageData(0, 0, dw, dh);
}

function run(lm, imgData) {
  const r = lm.detect(imgData);
  return (r.faceLandmarks || []).map((pts) => OVAL.map((i) => [pts[i].x, pts[i].y]));
}

const center = (poly) => poly.reduce((a, [x, y]) => [a[0] + x / poly.length, a[1] + y / poly.length], [0, 0]);
const width = (poly) => Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0]));

/** src: ImageBitmap / canvas at any size. Returns polygons [[x,y],...] in 0..1 image coords, or null if the model failed. */
export async function detectFaces(src) {
  const lm = await landmarker();
  if (!lm) return null;
  const W = src.width, H = src.height;
  const s = Math.min(1, 1024 / Math.max(W, H));
  let faces = run(lm, draw(src, 0, 0, W, H, Math.round(W * s), Math.round(H * s)));
  if (faces.length) return faces;
  // tiles: 3 x 3 grid with overlap, each tile ~1/2 of the frame, sampled at up to 768 px
  const tw = W / 2, th = H / 2;
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const x0 = (gx * (W - tw)) / 2, y0 = (gy * (H - th)) / 2;
      const ts = Math.min(1, 768 / Math.max(tw, th));
      const found = run(lm, draw(src, x0, y0, tw, th, Math.round(tw * ts), Math.round(th * ts)));
      for (const poly of found) {
        const g = poly.map(([x, y]) => [(x0 + x * tw) / W, (y0 + y * th) / H]);
        const [cx, cy] = center(g), wd = width(g);
        if (!faces.some((f) => { const [fx, fy] = center(f); return Math.hypot(fx - cx, fy - cy) < 0.6 * Math.max(wd, width(f)); })) faces.push(g);
      }
    }
  }
  return faces;
}
