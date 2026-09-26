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
