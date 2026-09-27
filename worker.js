// Engine worker: decode, measure, solve, render previews, export full resolution.
import { prepare, measure } from './engine/measure.js';
import { solve, solvePreset } from './engine/solver.js';
import { buildLUT, applyLUT, processPixelSet, SLIDERS } from './engine/pipeline.js';
import { lossReport, culprits } from './engine/loss.js';
import { xmpPacket, xmpPreset } from './engine/xmp.js';
import { exifSegment, xmpSegment, insertSegments, isJpeg } from './engine/jpegmeta.js';
import encodeJpeg from './vendor/jpeg-encoder.js';
import { parse as parseExif } from './vendor/exifr-lite.mjs';
import { detectFaces } from './faces.js';
import { sceneFromExif } from './engine/scene.js';

const SOLVE_SIDE = 512;
const cache = new Map(); // id -> { file, ps, o, display: {w,h,data}, lastUse }

function canvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

async function bitmap(file) {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

function scaledData(bmp, maxSide) {
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  // step down in halves for a cleaner downscale
  let src = bmp, sw = bmp.width, sh = bmp.height;
  while (sw / 2 > w * 1.5) {
    const nw = Math.round(sw / 2), nh = Math.round(sh / 2);
    const [c, x] = canvas(nw, nh);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, nw, nh);
    src = c; sw = nw; sh = nh;
  }
  const [c, x] = canvas(w, h);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
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
  for (const [, v] of entries.slice(3)) { v.ps = null; v.display = null; }
  return e;
}

// Faces are found on the full image (faces.js scales it, and tiles it if nothing is found);
// outlines are in 0..1 coordinates, so they apply to the 512 px measurement preview directly.
async function analyze(e, bmp) {
  if (e.faces === undefined) {
    try { e.faces = await detectFaces(bmp); } catch (err) { e.faces = null; }
  }
  if (e.scene === undefined) {
    try { e.scene = sceneFromExif(await parseExif(e.file, { ifd0: true, exif: true, gps: false, interop: false })); } catch (err) { e.scene = null; }
  }
  e.ps = prepare(scaledData(bmp, SOLVE_SIDE), { faces: e.faces });
}

async function ensurePrepared(id) {
  const e = cache.get(id);
  if (!e) throw new Error('photo not loaded');
  if (!e.ps) {
    const bmp = await bitmap(e.file);
    e.fullW = bmp.width; e.fullH = bmp.height;
    await analyze(e, bmp);
    bmp.close();
  }
  touch(id);
  return e;
}

async function ensureDisplay(id, side) {
  const e = await ensurePrepared(id);
  if (!e.display || e.display.side !== side) {
    const bmp = await bitmap(e.file);
    const d = scaledData(bmp, side);
    bmp.close();
    e.display = { ...d, side };
  }
  return e;
}

function renderInto(src, params) {
  const lut = buildLUT(params, 33);
  const out = new Uint8ClampedArray(src.width * src.height * 4);
  applyLUT(lut, src.data, out, src.width * src.height, 4, 4);
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
    const bmp = await bitmap(file);
    const e = { file };
    await analyze(e, bmp);
    const stats = measure(e.ps);
    stats.scene = e.scene;
    const thumb = await toJpegBlob(scaledData(bmp, 480), 0.85);
    bmp.close();
    return { stats, thumb };
  },

  async load({ id, file }) {
    cache.set(id, { file, ps: null, lastUse: performance.now() });
    const bmp = await bitmap(file);
    const e = cache.get(id);
    await analyze(e, bmp);
    const thumb = await toJpegBlob(scaledData(bmp, 320), 0.8);
    e.fullW = bmp.width; e.fullH = bmp.height;
    bmp.close();
    touch(id);
    return { stats: measure(e.ps), thumb, width: e.fullW, height: e.fullH, scene: e.scene, faces: e.faces ? e.faces.length : null };
  },

  async solve({ id, refStats, strength, lrParams = null }) {
    const e = await ensurePrepared(id);
    const o = measure(e.ps);
    const res = lrParams
      ? solvePreset(e.ps, o, lrParams, { strength, scene: e.scene })
      : solve(e.ps, o, refStats, { strength, scene: e.scene });
    const cur = processPixelSet(e.ps, res.params);
    const after = measure(e.ps, cur);
    const loss = lossReport(e.ps, cur, res.params);
    return { params: res.params, targets: res.targets, before: o, after, loss, scene: e.scene, timings: res.timings, guardScale: res.guardScale };
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

  async preview({ id, params, side = 1400, withOriginal = false, overlay = false }) {
    const e = await ensureDisplay(id, side);
    const out = renderInto(e.display, params);
    if (overlay) paintClipping(e.display.data, out.data);
    const edited = await createImageBitmap(new ImageData(out.data, out.width, out.height));
    let original = null;
    if (withOriginal) original = await createImageBitmap(new ImageData(new Uint8ClampedArray(e.display.data), e.display.width, e.display.height));
    return { edited, original, transfer: [edited, ...(original ? [original] : [])] };
  },

  async export({ id, params, quality = 92, lightroom = false, lrMode = 'sliders', name = 'photo' }) {
    const e = cache.get(id);
    const t0 = performance.now();
    const bmp = await bitmap(e.file);
    const W = bmp.width, H = bmp.height;
    const lut = buildLUT(params, 33);
    const rgba = new Uint8ClampedArray(W * H * 4);
    // tiles keep each canvas well under iOS Safari's ~16.7 MP canvas limit
    const tileH = Math.max(64, Math.min(H, Math.floor(4_000_000 / W)));
    const [c, x] = canvas(W, tileH);
    for (let y = 0; y < H; y += tileH) {
      const h = Math.min(tileH, H - y);
      x.clearRect(0, 0, W, tileH);
      x.drawImage(bmp, 0, y, W, h, 0, 0, W, h);
      const d = x.getImageData(0, 0, W, h).data;
      applyLUT(lut, d, rgba.subarray(y * W * 4, (y + h) * W * 4), W * h, 4, 4, 1 + y);
      postMessage({ progress: { id, phase: 'render', f: (y + h) / H } });
    }
    bmp.close();
    const t1 = performance.now();
    postMessage({ progress: { id, phase: 'encode', f: 0 } });
    let jpg = encodeJpeg({ data: rgba, width: W, height: H }, quality).data;
    const t2 = performance.now();
    const orig = new Uint8Array(await e.file.arrayBuffer());
    const add = [];
    if (isJpeg(orig)) { const ex = exifSegment(orig); if (ex) add.push(ex); }
    add.push(xmpSegment(`<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="LookMatch"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`));
    jpg = insertSegments(jpg, add);
    const out = { jpeg: new Blob([jpg], { type: 'image/jpeg' }), width: W, height: H, ms: { render: t1 - t0, encode: t2 - t1 } };
    if (lightroom) {
      out.xmp = xmpPreset(params, `LookMatch ${name}`, lrMode);
      if (isJpeg(orig)) out.lrCopy = new Blob([insertSegments(orig, [xmpSegment(xmpPacket(params, lrMode))], { dropXmp: true })], { type: 'image/jpeg' });
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
    postMessage({ rid, ok: false, error: String(err && err.stack || err) });
  }
};
