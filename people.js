// Per-person segmentation from MediaPipe Pose Landmarker, with conservative face-only fallback.
import { PoseLandmarker } from './vendor/mediapipe/vision_bundle.mjs';
import { lazyTask } from './mp.js';
import { assignPeople } from './engine/skin-people.js';

const MAX_SIDE = 768;
export const landmarker = lazyTask('people', PoseLandmarker, {
  baseOptions: { modelAssetPath: new URL('./models/pose_landmarker_lite.task', import.meta.url).href, delegate: 'CPU' },
  runningMode: 'IMAGE', numPoses: 8, outputSegmentationMasks: true,
  minPoseDetectionConfidence: 0.45, minPosePresenceConfidence: 0.45,
});

function makeInput(bmp) {
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * s));
  const height = Math.max(1, Math.round(bmp.height * s));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  return { image: ctx.getImageData(0, 0, width, height), width, height };
}

function resample(mask, sw, sh, width, height) {
  const out = new Uint8Array(width * height);
  if (!sw || !sh || mask.length < sw * sh) return out;
  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) * sh / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) * sw / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const a = mask[y0 * sw + x0] * (1 - fx) + mask[y0 * sw + x1] * fx;
      const b = mask[y1 * sw + x0] * (1 - fx) + mask[y1 * sw + x1] * fx;
      out[y * width + x] = Math.max(0, Math.min(255, Math.round((a * (1 - fy) + b * fy) * 255)));
    }
  }
  return out;
}

function centers(result) {
  return (result.landmarks || []).map((points, i) => {
    const nose = points[0];
    return { id: i + 1, x: nose?.x ?? 0.5, y: nose?.y ?? 0.5 };
  });
}

/**
 * Detect people in bmp. Returns labels at requested w x h dimensions plus id positions.
 * Each label uses the same image-local id through later crop/resampling steps.
 */
export async function detectPeople(bmp, w, h, faces = [], skin = null) {
  const detector = await landmarker();
  if (detector) {
    try {
      const input = makeInput(bmp);
      const result = detector.detect(input.image);
      try {
        const masks = (result.segmentationMasks || []).map((mask) => {
          const values = Float32Array.from(mask.getAsFloat32Array());
          return resample(values, mask.width, mask.height, w, h);
        });
        const posePositions = centers(result);
        const assigned = assignPeople({ width: w, height: h, poseMasks: masks, positions: posePositions, faces, skin });
        return { ...assigned, method: masks.length && posePositions.length ? 'pose' : 'face', scope: 'image' };
      } finally { result.close(); }
    } catch (error) {
      console.warn('people model inference failed:', error);
    }
  }
  const fallback = assignPeople({ width: w, height: h, faces, skin });
  return { ...fallback, method: 'face', scope: 'image' };
}
