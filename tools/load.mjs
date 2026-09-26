// Node-side image loading for the test tools. The browser app has its own loader.
import sharp from 'sharp';
import fs from 'fs';
import heicDecode from 'heic-decode';

export async function toSharp(path) {
  if (/\.(heic|heif|hif)$/i.test(path)) {
    const r = await heicDecode({ buffer: fs.readFileSync(path) });
    return sharp(Buffer.from(r.data.buffer), { raw: { width: r.width, height: r.height, channels: 4 } }).removeAlpha();
  }
  return sharp(path).rotate();
}

export async function loadPreview(path, maxSide = 512) {
  const s = await toSharp(path);
  const { data, info } = await s.resize(maxSide, maxSide, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data, channels: info.channels };
}

export async function loadFull(path) {
  const s = await toSharp(path);
  const { data, info } = await s.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data, channels: info.channels };
}

// Camera settings: from the file, or from a <name>.exif.json sidecar (for test files converted from HEIF).
import exifr from 'exifr';
import { sceneFromExif, EXIF_TAGS } from '../engine/scene.js';
export async function readScene(path) {
  const side = path.replace(/\.[^.]+$/, '.exif.json');
  if (fs.existsSync(side)) return sceneFromExif(JSON.parse(fs.readFileSync(side, 'utf8')));
  try { return sceneFromExif(await exifr.parse(path, EXIF_TAGS)); } catch (e) { return null; }
}

// Face outlines computed by tools/faces.mjs (MediaPipe in a headless browser), cached in testdata/faces.json.
export function readFaces(path) {
  const f = 'testdata/faces.json';
  if (!fs.existsSync(f)) return null;
  const all = JSON.parse(fs.readFileSync(f, 'utf8'));
  return all[path.split('/').pop()] ?? null;
}
