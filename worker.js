// Engine worker: decode, measure, solve, render previews, export full resolution.
import { prepare, measure } from './engine/measure.js';
import { solve, solvePreset } from './engine/solver.js';
import { fitFinish, FINISH_PROFILES } from './engine/finish.js';
import { buildLUT, applyLUT, applyFinish, hasSpatialFinish, processPixelSet, SLIDERS } from './engine/pipeline.js';
import { lossReport, culprits } from './engine/loss.js';
import { xmpPacket, xmpPreset } from './engine/xmp.js';
import { exifSegment, xmpSegment, insertSegments, isJpeg, jpegOrientation } from './engine/jpegmeta.js';
import { isIdentityGeom, geomKey, geomSize, drawTransform, mapPolys, lightroomCrop, autoLevel } from './engine/geom.js';
import encodeJpeg from './vendor/jpeg-encoder.js';
import { parse as parseExif } from './vendor/exifr-lite.mjs';
import { detectFaces } from './faces.js';
import { sceneFromExif } from './engine/scene.js';

const SOLVE_SIDE = 512;
// id -> { file (decodable), orig (what was picked), geom, ps, display, gdisplay, faces, scene, lastUse }
const cache = new Map();

function canvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

// ---------------------------------------------------------------- decoding
// Order: the browser's own decoder (with, then without, EXIF orientation options), then libheif for
// HEIF/HEIC/HIF files the browser can't read (Fujifilm .HIF is 10-bit HEVC; Chrome has no HEIF at all).
// A HEIF that needed libheif is converted once to a q97 JPEG, so every later step decodes natively.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif', 'mif2']);
async function heifBrand(file) {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const str = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 16 || str(4) !== 'ftyp') return null;
  const major = str(8);
  if (major === 'avif' || major === 'avis') return null;
  if (HEIF_BRANDS.has(major)) return major;
  const size = Math.min(b.length, (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0);
  for (let o = 16; o + 4 <= size; o += 4) if (HEIF_BRANDS.has(str(o))) return str(o);
  return null;
}

let heifLib = null;
async function decodeHeif(file) {
  if (!heifLib) heifLib = import('./vendor/libheif/libheif-bundle.mjs').then(async (m) => { const lib = m.default(); await lib.ready; return lib; });
  const lib = await heifLib;
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  try {
    if (!images || !images.length) throw new Error('no image inside the HEIF file');
    // primary image is first; libheif applies the file's rotation/mirror itself
    const im = images[0], width = im.get_width(), height = im.get_height();
    const data = await new Promise((res, rej) => im.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? res(d.data) : rej(new Error('HEIF decode failed')))));
    return { width, height, data };
  } finally {
    for (const im of images || []) im.free();
    decoder.decoder.delete();
  }
}

const describe = (f) => `${f.name || 'photo'} (${f.type || 'no type'}, ${(f.size / 1048576).toFixed(1)} MB)`;

async function nativeBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e1) {
    try { return await createImageBitmap(file); } catch (e2) { throw e1; }
  }
}

/** Decode entry e (its file may be swapped for a JPEG the first time). Returns an ImageBitmap. */
async function openBitmap(e, id = null) {
  try { return await nativeBitmap(e.file); } catch (err) {
    const brand = await heifBrand(e.file);
    if (!brand) throw new Error(`Couldn't decode ${describe(e.file)}: ${err && err.message || err}`);
    if (id) postMessage({ progress: { id, phase: 'heif', f: 0 } });
    let img;
    try { img = await decodeHeif(e.file); } catch (err2) { throw new Error(`Couldn't decode HEIF ${describe(e.file)}: ${err2 && err2.message || err2}`); }
    const jpg = encodeJpeg({ data: img.data, width: img.width, height: img.height }, 97).data;
    e.orig = e.orig || e.file;
    e.file = new Blob([jpg], { type: 'image/jpeg' });
    e.converted = `HEIF (${brand})`;
    return nativeBitmap(e.file);
  }
}

// ---------------------------------------------------------------- scaling + geometry
function stepDown(bmp, targetW) {
  // halve with high-quality smoothing until within 1.5x of the target width (cleaner than one big jump)
  let src = bmp, sw = bmp.width, sh = bmp.height;
  while (sw / 2 > targetW * 1.5) {
    const nw = Math.round(sw / 2), nh = Math.round(sh / 2);
    const [c, x] = canvas(nw, nh);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, nw, nh);
    src = c; sw = nw; sh = nh;
  }
  return [src, sw, sh];
}

/** RGBA of the photo (optionally cropped/levelled) with the long side at most maxSide. */
function scaledData(bmp, maxSide, g = null) {
  const W = bmp.width, H = bmp.height;
  const [OW, OH] = geomSize(W, H, g);
  const s = Math.min(1, maxSide / Math.max(OW, OH));
  const w = Math.max(1, Math.round(OW * s)), h = Math.max(1, Math.round(OH * s));
  const [src, sw, sh] = stepDown(bmp, W * s);
  const [c, x] = canvas(w, h);
  x.imageSmoothingQuality = 'high';
  if (isIdentityGeom(g)) x.drawImage(src, 0, 0, w, h);
  else {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.setTransform(...drawTransform(sw, sh, g, (W * s) / sw));
    x.drawImage(src, 0, 0, sw, sh);
  }
  const d = x.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data, channels: 4 };
}

async function toJpegBlob(img, quality = 0.9) {
  const [c, x] = canvas(img.width, img.height);
  x.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4), img.width, img.height), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

function touch(id) {
  const e = cache.get(id);
  if (e) e.lastUse = performance.now();
  // keep at most 3 prepared photos per worker; stats/params live in the main thread
  const entries = [...cache.entries()].filter(([, v]) => v.ps).sort((a, b) => b[1].lastUse - a[1].lastUse);
  for (const [, v] of entries.slice(3)) { v.ps = null; v.display = null; v.gdisplay = null; v.sample = null; }
  return e;
}

// Faces are found on the full photo (faces.js scales it, and tiles it if nothing is found);
// outlines are in 0..1 coordinates of the whole photo, mapped into the crop for measuring.
async function analyze(e, bmp) {
  if (e.faces === undefined) {
    try { e.faces = await detectFaces(bmp); } catch (err) { e.faces = null; }
  }
  if (e.scene === undefined) {
    try { e.scene = sceneFromExif(await parseExif(e.orig || e.file, { ifd0: true, exif: true, gps: false, interop: false })); } catch (err) { e.scene = null; }
  }
  e.fullW = bmp.width; e.fullH = bmp.height;
  e.ps = prepare(scaledData(bmp, SOLVE_SIDE, e.geom), { faces: mapPolys(e.faces, bmp.width, bmp.height, e.geom) });
}

async function ensurePrepared(id) {
  const e = cache.get(id);
  if (!e) throw new Error('photo not loaded');
  if (!e.ps) {
    const bmp = await openBitmap(e, id);
    await analyze(e, bmp);
    bmp.close();
  }
  touch(id);
  return e;
}

async function ensureDisplay(id, side, plain) {
  const e = await ensurePrepared(id);
  const g = plain ? null : e.geom;
  const slot = isIdentityGeom(g) ? 'display' : 'gdisplay';
  const key = `${side}|${geomKey(g)}`;
  if (!e[slot] || e[slot].key !== key) {
    const bmp = await openBitmap(e, id);
    const d = scaledData(bmp, side, g);
    bmp.close();
    e[slot] = { ...d, key };
  }
  return e[slot];
}

function renderInto(src, params) {
  const lut = buildLUT(params, 33);
  const out = new Uint8ClampedArray(src.width * src.height * 4);
  applyLUT(lut, src.data, out, src.width * src.height, 4, 4);
  if (hasSpatialFinish(params)) applyFinish(out, src.width, src.height, params);
  return { width: src.width, height: src.height, data: out };
}

// Clipping overlay, same classes as engine/loss.js. Bright = caused by the edit, dim = already in the original.
function clipClass(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx >= 254 && 0.299 * r + 0.587 * g + 0.114 * b >= 228) return 1; // blown
  if (mx <= 2) return 2;                                                 // crushed
  if (mx >= 254 || mn <= 1) return 3;                                    // clipped color
  return 0;
}
const PAINT = { 1: [[255, 30, 30], [150, 70, 70]], 2: [[40, 110, 255], [50, 60, 120]], 3: [[255, 185, 0], [140, 115, 50]] };
function paintClipping(orig, out) {
  for (let i = 0; i < out.length; i += 4) {
    const c = clipClass(out[i], out[i + 1], out[i + 2]);
    if (!c) continue;
    const was = clipClass(orig[i], orig[i + 1], orig[i + 2]) === c;
    const [r, g, b] = PAINT[c][was ? 1 : 0];
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
}

const handlers = {
  async measureRef({ file }) {
    const e = { file };
    const bmp = await openBitmap(e);
    await analyze(e, bmp);
    const stats = measure(e.ps);
    stats.scene = e.scene;
    const thumb = await toJpegBlob(scaledData(bmp, 480), 0.85);
    bmp.close();
    return { stats, thumb, converted: e.converted || null };
  },

  async load({ id, file }) {
    cache.set(id, { file, ps: null, geom: null, lastUse: performance.now() });
    const e = cache.get(id);
    const bmp = await openBitmap(e, id);
    await analyze(e, bmp);
    const thumb = await toJpegBlob(scaledData(bmp, 320), 0.8);
    bmp.close();
    touch(id);
    return { stats: measure(e.ps), thumb, width: e.fullW, height: e.fullH, scene: e.scene, faces: e.faces ? e.faces.length : null, converted: e.converted || null };
  },

  // crop/level for one photo; everything measured afterwards (solve, loss checks) sees only the crop
  async setGeom({ id, geom }) {
    const e = cache.get(id);
    if (!e) throw new Error('photo not loaded');
    const g = isIdentityGeom(geom) ? null : geom;
    if (geomKey(g) !== geomKey(e.geom)) { e.geom = g; e.ps = null; e.gdisplay = null; e.sample = null; }
    await ensurePrepared(id);
    return { before: measure(e.ps) };
  },

  async autoLevel({ id }) {
    const e = cache.get(id);
    if (!e) throw new Error('photo not loaded');
    const bmp = await openBitmap(e, id);
    const d = scaledData(bmp, 640);
    bmp.close();
    const gray = new Float32Array(d.width * d.height);
    for (let i = 0; i < gray.length; i++) gray[i] = (0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2]) / 255;
    return autoLevel(gray, d.width, d.height);
  },

  async solve({ id, refStats, strength, lrParams = null, finish = 'off', finishStrength = 1 }) {
    const e = await ensurePrepared(id);
    const o = measure(e.ps);
    const res = lrParams
      ? solvePreset(e.ps, o, lrParams, { strength, scene: e.scene })
      : solve(e.ps, o, refStats, { strength, scene: e.scene });
    let style = null;
    if (finish && finish !== 'off' && FINISH_PROFILES[finish]) {
      const f = fitFinish(e.ps, res.params, FINISH_PROFILES[finish], null, { strength: finishStrength });
      res.params = f.params; style = f.style;
    }
    const cur = processPixelSet(e.ps, res.params);
    const after = measure(e.ps, cur);
    const loss = lossReport(e.ps, cur, res.params);
    return { params: res.params, targets: res.targets, before: o, after, loss, scene: e.scene, timings: res.timings, guardScale: res.guardScale, style };
  },

  async measureParams({ id, params, auto = null }) {
    const e = await ensurePrepared(id);
    const cur = processPixelSet(e.ps, params);
    const loss = lossReport(e.ps, cur, params);
    if (loss.issues.length) {
      // rank the sliders responsible on a 15k-pixel sample (fast enough to run on every slider release)
      if (!e.sample) {
        const idx = []; const step = Math.max(1, Math.floor(e.ps.n / 15000));
        for (let i = 0; i < e.ps.n; i += step) idx.push(i);
        e.sample = Int32Array.from(idx);
      }
      const scratch = { L: new Float32Array(e.ps.n), A: new Float32Array(e.ps.n), B: new Float32Array(e.ps.n), lr: new Float32Array(e.ps.n), lg: new Float32Array(e.ps.n), lb: new Float32Array(e.ps.n) };
      loss.culprits = culprits(e.ps, params, (q, idx, c) => processPixelSet(e.ps, q, idx, c), e.sample, scratch, SLIDERS.map((s) => s.key), auto);
    }
    return { after: measure(e.ps, cur), loss };
  },

  // plain: the whole photo without crop/level (the crop tool draws its own frame over it)
  async preview({ id, params, side = 1400, withOriginal = false, overlay = false, plain = false }) {
    const d = await ensureDisplay(id, side, plain);
    const out = renderInto(d, params);
    if (overlay) paintClipping(d.data, out.data);
    const edited = await createImageBitmap(new ImageData(out.data, out.width, out.height));
    let original = null;
    if (withOriginal) original = await createImageBitmap(new ImageData(new Uint8ClampedArray(d.data), d.width, d.height));
    return { edited, original, transfer: [edited, ...(original ? [original] : [])] };
  },

  async export({ id, params, geom = undefined, quality = 92, lightroom = false, lrMode = 'sliders', name = 'photo' }) {
    const e = cache.get(id);
    if (!e) throw new Error('photo not loaded');
    const g = geom === undefined ? e.geom : (isIdentityGeom(geom) ? null : geom);
    const t0 = performance.now();
    const bmp = await openBitmap(e, id);
    const W = bmp.width, H = bmp.height;
    const [OW, OH] = geomSize(W, H, g);
    const lut = buildLUT(params, 33);
    const rgba = new Uint8ClampedArray(OW * OH * 4);
    // tiles keep each canvas well under iOS Safari's ~16.7 MP canvas limit
    const tileH = Math.max(64, Math.min(OH, Math.floor(4_000_000 / OW)));
    const [c, x] = canvas(OW, tileH);
    x.imageSmoothingQuality = 'high';
    for (let y = 0; y < OH; y += tileH) {
      const h = Math.min(tileH, OH - y);
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, OW, tileH);
      if (isIdentityGeom(g)) x.drawImage(bmp, 0, y, W, h, 0, 0, W, h);
      else {
        x.fillStyle = '#000'; x.fillRect(0, 0, OW, tileH);
        x.setTransform(...drawTransform(W, H, g, 1, y));
        x.drawImage(bmp, 0, 0);
      }
      const d = x.getImageData(0, 0, OW, h).data;
      const band = rgba.subarray(y * OW * 4, (y + h) * OW * 4);
      applyLUT(lut, d, band, OW * h, 4, 4, 1 + y);
      if (hasSpatialFinish(params)) applyFinish(band, OW, h, params, y, OW, OH);
      postMessage({ progress: { id, phase: 'render', f: (y + h) / OH } });
    }
    bmp.close();
    const t1 = performance.now();
    postMessage({ progress: { id, phase: 'encode', f: 0 } });
    let jpg = encodeJpeg({ data: rgba, width: OW, height: OH }, quality).data;
    const t2 = performance.now();
    const orig = new Uint8Array(await (e.orig || e.file).arrayBuffer());
    const origJpeg = isJpeg(orig) && !e.converted;
    const add = [];
    if (origJpeg) { const ex = exifSegment(orig); if (ex) add.push(ex); }
    add.push(xmpSegment(`<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="LookMatch"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`));
    jpg = insertSegments(jpg, add);
    const out = { jpeg: new Blob([jpg], { type: 'image/jpeg' }), width: OW, height: OH, ms: { render: t1 - t0, encode: t2 - t1 } };
    if (lightroom) {
      const crop = lightroomCrop(g, W, H, origJpeg ? jpegOrientation(orig) : 1);
      out.xmp = xmpPreset(params, `LookMatch ${name}`, lrMode, crop);
      if (origJpeg) out.lrCopy = new Blob([insertSegments(orig, [xmpSegment(xmpPacket(params, lrMode, crop))], { dropXmp: true })], { type: 'image/jpeg' });
    }
    return out;
  },

  async unload({ id }) { cache.delete(id); return {}; },
};

onmessage = async (ev) => {
  const { rid, type, args } = ev.data;
  try {
    const res = await handlers[type](args);
    const transfer = res.transfer || [];
    delete res.transfer;
    postMessage({ rid, ok: true, res }, transfer);
  } catch (err) {
    postMessage({ rid, ok: false, error: String((err && err.message) || err), stack: String((err && err.stack) || '') });
  }
};
