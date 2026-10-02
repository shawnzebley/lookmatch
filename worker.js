// Engine worker: decode, measure, solve, render previews, export full resolution.
import { prepare, measure, regionStats, regionUsable, halationSignature } from './engine/measure.js';
import { solve, solvePreset } from './engine/solver.js';
import { referenceRegionTargets, solveMaskedReference } from './engine/masked-reference.js';
import { fitSkinMatch, applySkinMatchRGBA } from './engine/skin-match.js';
import { fitFinish, FINISH_PROFILES } from './engine/finish.js';
import { fitRegions, fitReferenceRegions, REGION_MOVE, REF_REGION } from './engine/regions.js';
import { signature, nearestRegions } from './engine/style.js';
import { compile, buildLUTs, applyLUTs, applyFinish, applyHalation, halationRadius, hasSpatialFinish, hasLocal, processPixelSet, curveLUT, SLIDERS, LOCAL_SLIDERS, REGIONS, withLocal } from './engine/pipeline.js';
import { hasSkinPass, hasHeals, applySkinPass, skinHalo, healsToOut, healBox, healBuffer, pickHealSource } from './engine/retouch.js';
import { lossReport, culprits } from './engine/loss.js';
import { xmpPacket, xmpPreset } from './engine/xmp.js';
import { exifSegment, xmpSegment, insertSegments, isJpeg, jpegOrientation } from './engine/jpegmeta.js';
import { isIdentityGeom, geomKey, geomSize, drawTransform, mapPolys, lightroomCrop, autoLevel, toSource } from './engine/geom.js';
import encodeJpeg from './vendor/jpeg-encoder.js';
import { parse as parseExif } from './vendor/exifr-lite.mjs';
import { detectFaces, landmarker } from './faces.js';
import { detectPeople, landmarker as peopleLandmarker } from './people.js';
import { personMask, tapMask, maskCanvasSize, segmenter } from './segment.js';
import { visionErrors, LOADER, WASM, MP_BUILD } from './mp.js';
import { sceneFromExif } from './engine/scene.js';
import { edgeSharpness, focusScore, FOCUS_SIDE, eyesClosed, sceneSig } from './engine/cull.js';
import { srgbToLinear, linearToSrgb, lToY } from './engine/color.js';
import { stylizeRemote } from './lib/deeppreset.js';
import { autoAdjustResult, hasReferenceCurve, skinWhiteBalance, presenceFor, highlightRollOff } from './engine/auto-adjust.js';

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
  for (const [, v] of entries.slice(3)) { v.ps = null; v.display = null; v.gdisplay = null; v.sample = null; if (v.mask) v.mask.canvases = {}; }
  return e;
}

// ---------------------------------------------------------------- subject mask
// e.mask = { w, h, person (0..255 people found by the model), personFrac, useAuto, picks: [{ add, x, y, data }],
//            sub (the combined subject), frac, ver, ok, skin (0..255 facial + body skin), skinFrac }.
//            Working size, whole uncropped photo.
async function ensureMask(e, bmp) {
  if (e.mask !== undefined) return;
  let m = null, why = null;
  try { m = await personMask(bmp); } catch (err) { console.warn('person mask failed', err); why = `people finder failed while running: ${(err && err.message) || err}`; }
  if (!m && !why) why = (visionErrors.person && visionErrors.person.message) || "the people model didn't start";
  const [w, h] = m ? [m.w, m.h] : maskCanvasSize(bmp.width, bmp.height);
  const skin = m && m.skin ? m.skin : new Uint8Array(w * h);
  let people = null;
  try {
    if (e.faces === undefined) {
      try { e.faces = await detectFaces(bmp); } catch { e.faces = null; }
    }
    if ((m?.skinFrac || 0) >= 0.0005) people = await detectPeople(bmp, w, h, e.faces || [], skin);
  } catch (err) { console.warn('per-person mask failed', err); }
  const skinPeople = people?.labels || new Uint8Array(w * h);
  const skinPositions = people?.positions || [];
  let peopleLabeled = 0; for (const id of skinPeople) if (id) peopleLabeled++;
  e.mask = { w, h, person: m ? m.data : new Uint8Array(w * h), personFrac: m ? m.frac : 0, ok: !!m, err: m ? null : why, useAuto: true, picks: [], sub: null, frac: 0, ver: 0,
    skin, skinFrac: m && m.skin ? m.skinFrac : 0, skinPeople, skinPositions, peopleMethod: people?.method || 'none',
    peopleAmbiguous: people?.ambiguous || 0, peopleLabeled, canvases: {} };
  combineMask(e);
}

function combineMask(e) {
  const M = e.mask, n = M.w * M.h;
  let sub;
  if (!M.picks.length) sub = M.useAuto ? M.person : new Uint8Array(n);
  else {
    sub = M.useAuto ? Uint8Array.from(M.person) : new Uint8Array(n);
    for (const pk of M.picks) {
      const d = pk.data;
      if (pk.add) { for (let i = 0; i < n; i++) if (d[i] > sub[i]) sub[i] = d[i]; }
      else for (let i = 0; i < n; i++) sub[i] = ((sub[i] * (255 - d[i])) / 255) | 0;
    }
  }
  let on = 0; for (let i = 0; i < n; i++) on += sub[i];
  M.sub = sub; M.frac = on / 255 / n; M.ver++; M.canvases = {};
}

const faceError = () => (visionErrors.face && visionErrors.face.message) || null;

const maskInfo = (e) => {
  const M = e.mask;
  if (!M) return null;
  return { ok: M.ok, err: M.err || null, people: M.personFrac >= 0.005, personFrac: M.personFrac, useAuto: M.useAuto, picks: M.picks.length, frac: M.frac, ver: M.ver, skin: M.skinFrac || 0,
    peopleMethod: M.peopleMethod || 'none', peopleGroups: M.skinPositions?.length || 0, peopleFaceFallbacks: M.skinPositions?.filter((p) => p.scope === 'face').length || 0,
    peopleAmbiguous: M.peopleAmbiguous || 0, peopleLabeled: M.peopleLabeled || 0 };
};

// key: 'sub' (the subject) or 'skin'
function maskCanvas(M, key = 'sub') {
  M.canvases ||= {};
  if (!M.canvases[key]) {
    const src = M[key];
    const [c, x] = canvas(M.w, M.h);
    const d = new ImageData(M.w, M.h);
    for (let i = 0, j = 0; i < src.length; i++, j += 4) { const v = src[i]; d.data[j] = d.data[j + 1] = d.data[j + 2] = v; d.data[j + 3] = 255; }
    x.putImageData(d, 0, 0);
    M.canvases[key] = c;
  }
  return M.canvases[key];
}

/**
 * The subject mask (0..255) for an output ow x oh showing the photo with geometry g. photoScale = output px
 * per photo px (default: the output is the whole geometry at ow wide); oy = first row, for export tiles.
 */
function maskFor(e, ow, oh, g, oy = 0, photoScale = null, key = 'sub') {
  const M = e.mask;
  if (!M || !M[key] || (key === 'sub' ? M.frac : key === 'skin' ? M.skinFrac : M.peopleLabeled) < 0.0005) return null;
  const W = e.fullW, H = e.fullH;
  const s = photoScale ?? ow / geomSize(W, H, g)[0];
  const k = (s * W) / M.w; // output px per mask px
  const [, x] = canvas(ow, oh);
  x.imageSmoothingEnabled = key !== 'skinPeople';
  x.imageSmoothingQuality = 'high';
  x.fillStyle = '#000'; x.fillRect(0, 0, ow, oh);
  if (isIdentityGeom(g)) x.setTransform(k, 0, 0, (s * H) / M.h, 0, -oy);
  else x.setTransform(...drawTransform(M.w, M.h, g, k, oy));
  x.drawImage(maskCanvas(M, key), 0, 0);
  const d = x.getImageData(0, 0, ow, oh).data;
  const out = new Uint8Array(ow * oh);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

function mapPositions(positions, W, H, g) {
  if (!positions || isIdentityGeom(g)) return positions || [];
  return positions.map((p) => {
    const [[[x, y]]] = mapPolys([[[p.x, p.y]]], W, H, g);
    return { ...p, x, y };
  });
}

// LR-style overlay: the region being edited shows red
function paintMask(out, mask, region) {
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const a = 0.5 * (region === 'background' ? 255 - mask[i] : mask[i]) / 255;
    if (a <= 0) continue;
    out[j] = out[j] + (255 - out[j]) * a; out[j + 1] *= 1 - a * 0.85; out[j + 2] *= 1 - a * 0.85;
  }
}

// Faces are found on the full photo (faces.js scales it, and tiles it if nothing is found);
// outlines are in 0..1 coordinates of the whole photo, mapped into the crop for measuring.
async function analyze(e, bmp) {
  if (e.faces === undefined) {
    try { e.faces = await detectFaces(bmp); } catch (err) { e.faces = null; }
  }
  await ensureMask(e, bmp);
  if (e.scene === undefined) {
    try { e.scene = sceneFromExif(await parseExif(e.orig || e.file, { ifd0: true, exif: true, gps: false, interop: false })); } catch (err) { e.scene = null; }
  }
  e.fullW = bmp.width; e.fullH = bmp.height;
  const d = scaledData(bmp, SOLVE_SIDE, e.geom);
  e.ps = prepare(d, { faces: mapPolys(e.faces, bmp.width, bmp.height, e.geom), subject: maskFor(e, d.width, d.height, e.geom), skin: maskFor(e, d.width, d.height, e.geom, 0, null, 'skin') });
  e.ps.skinPeople = maskFor(e, d.width, d.height, e.geom, 0, null, 'skinPeople') || new Uint8Array(e.ps.n);
  e.ps.skinPositions = mapPositions(e.mask?.skinPositions, bmp.width, bmp.height, e.geom);
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

// skin: the skin mask at src's size (for the skin pass); heals: spots in src px (healed before the LUT,
// like Lightroom's spot removal, which works on the photo before the develop settings)
function renderInto(src, params, mask = null, skin = null, heals = null, people = null) {
  const luts = buildLUTs(params, 33);
  const out = new Uint8ClampedArray(src.width * src.height * 4);
  let data = src.data;
  if (heals && heals.length) { data = Uint8ClampedArray.from(src.data); healBuffer(data, src.width, src.height, heals); }
  applyLUTs(luts, mask, data, out, src.width * src.height, 4, 4);
  if (skin && params.skinMatch) applySkinMatchRGBA(out, params.skinMatch, skin, 4, people, src.data);
  if (skin && hasSkinPass(params)) applySkinPass(out, src.width, src.height, params, skin, Math.max(src.width, src.height));
  if (params.halation) applyHalation(out, src.width, src.height, params.halation);
  if (hasSpatialFinish(params)) applyFinish(out, src.width, src.height, params);
  return { width: src.width, height: src.height, data: out };
}

// output px per photo px for a display of the photo's geometry g that is dw wide
const dispScale = (e, dw, g) => dw / geomSize(e.fullW, e.fullH, g)[0];
// a point given as 0..1 of the output (after crop/level) -> photo px
function outToPhoto(e, x, y, g) {
  const W = e.fullW, H = e.fullH;
  if (isIdentityGeom(g)) return [x * W, y * H];
  return toSource((g.x + x * g.w) * W, (g.y + y * g.h) * H, W, H, g.angle || 0);
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

// rows [ya, ya + hh) of the output (the photo with geometry g, at full size) into canvas context x
function drawBand(x, bmp, g, OW, ch, ya, hh, xa = 0) {
  const W = bmp.width, H = bmp.height;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, OW, ch);
  if (isIdentityGeom(g)) x.drawImage(bmp, xa, ya, OW, hh, 0, 0, OW, hh);
  else {
    x.fillStyle = '#000'; x.fillRect(0, 0, OW, ch);
    const m = drawTransform(W, H, g, 1, ya);
    m[4] -= xa;
    x.setTransform(...m);
    x.drawImage(bmp, 0, 0);
  }
}

// Heal spots are healed once at full size, in patches that hold both the spot and its source, then
// pasted into each band before the LUT (bands are too short to hold a spot's source).
function healPatches(bmp, g, OW, OH, spots) {
  const boxes = spots.map((s) => healBox(s, 3));
  const union = boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])]);
  const clip = (b) => [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(OW, b[2]), Math.min(OH, b[3])];
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  // one patch for all spots when that's small enough (spots on one face), else one per spot
  const groups = area(clip(union)) <= 8_000_000 ? [[clip(union), spots]] : spots.map((s, i) => [clip(boxes[i]), [s]]);
  const out = [];
  for (const [[bx0, by0, bx1, by1], ss] of groups) {
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw <= 0 || bh <= 0) continue;
    const [, x] = canvas(bw, bh);
    x.imageSmoothingQuality = 'high';
    drawBand(x, bmp, g, bw, bh, by0, bh, bx0);
    const buf = x.getImageData(0, 0, bw, bh).data;
    const local = ss.map((s) => ({ ...s, cx: s.cx - bx0, cy: s.cy - by0 }));
    healBuffer(buf, bw, bh, local);
    // only the spots themselves get pasted
    const rects = local.map((s) => [Math.max(0, Math.floor(s.cx - s.r - 1)), Math.max(0, Math.floor(s.cy - s.r - 1)), Math.min(bw, Math.ceil(s.cx + s.r + 1)), Math.min(bh, Math.ceil(s.cy + s.r + 1))]);
    out.push({ bx: bx0, by: by0, bw, buf, rects });
  }
  return out;
}
function pasteHealed(d, OW, hh, ya, patches) {
  for (const P of patches) for (const [x0, y0, x1, y1] of P.rects) {
    const r0 = Math.max(y0, ya - P.by), r1 = Math.min(y1, ya + hh - P.by);
    for (let r = r0; r < r1; r++) {
      const src = (r * P.bw + x0) * 4, dst = ((P.by + r - ya) * OW + P.bx + x0) * 4;
      d.set(P.buf.subarray(src, src + (x1 - x0) * 4), dst);
    }
  }
}

// ---------------------------------------------------------------- culling
// Per face: eyes closed? and a focus score (0-10, 8+ sharp) on the middle of the face (eyes, nose,
// mouth). No face: focus on the sharpest part of a 3 x 3 grid. Plus a scene signature for grouping.
function grayCrop(bmp, x0, y0, w, h) {
  const tw = Math.max(8, Math.round(Math.min(FOCUS_SIDE, w))), th = Math.max(8, Math.round((h * tw) / w));
  const [, x] = canvas(tw, th);
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, x0, y0, w, h, 0, 0, tw, th);
  const d = x.getImageData(0, 0, tw, th).data, g = new Float32Array(tw * th);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return [g, tw, th];
}
function cullInfo(e, bmp) {
  const W = bmp.width, H = bmp.height;
  const faces = (e.faces || []).map((poly) => {
    const xs = poly.map((q) => q[0] * W), ys = poly.map((q) => q[1] * H);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const fw = x1 - x0, fh = y1 - y0;
    const f = focusScore(edgeSharpness(...grayCrop(bmp, x0 + 0.2 * fw, y0 + 0.25 * fh, 0.6 * fw, 0.5 * fh)));
    const closed = poly.blink ? eyesClosed(poly.blink[0], poly.blink[1]) : null;
    return { size: fw / W, focus: f, closed };
  }).sort((a, b) => b.size - a.size);
  let focus = null;
  if (faces.length) focus = faces[0].focus;
  else {
    for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
      const v = focusScore(edgeSharpness(...grayCrop(bmp, (gx * W) / 3, (gy * H) / 3, W / 3, H / 3)));
      if (v != null && (focus == null || v > focus)) focus = v;
    }
  }
  const known = faces.filter((f) => f.closed != null);
  const eyes = !known.length ? null : known.some((f) => f.closed) ? 'closed' : 'open';
  const small = scaledData(bmp, 96);
  return { faces, focus, eyes, sig: sceneSig(small.data, small.width, small.height) };
}

// Auto Adjust curves, fitted to the photo as it looks after the rest of its edit (with the basic
// tone correction, without curves). Light curve: black and white points from the luminance range,
// the median pulled toward middle grey, the quartiles spread toward normal contrast (or eased off
// when the photo is already punchy), with no stretch steeper or flatter than AUTO_SLOPE.
// R/G/B curves: line each channel's dark, middle and bright levels up with the other two on the
// photo's least colourful pixels, which takes out a cast. When even those pixels are strongly
// coloured (a wood floor under tungsten, a sunset) the colour is the scene, so the correction fades,
// and a warm cast is only partly taken out (warm light usually reads as intended).
const AUTO_MID = 118, AUTO_QSPREAD = 92, AUTO_RGB_MAX = 18, AUTO_SLOPE = [0.5, 1.8];
const AUTO_GREY_FRAC = 0.15, AUTO_GREY_C = [10, 26], AUTO_WARM_KEEP = 0.4;
function autoCurves(ps, params) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cur = processPixelSet(ps, params);
  const n = ps.n;
  const usable = (i) => cur.L[i] > 12 && cur.L[i] < 95;
  const chroma = new Uint32Array(101);
  let nu = 0;
  for (let i = 0; i < n; i++) if (usable(i)) { chroma[Math.min(100, Math.round(Math.hypot(cur.A[i], cur.B[i])))]++; nu++; }
  let greyC = 100;
  for (let c = 0, acc = 0; c <= 100; c++) { acc += chroma[c]; if (acc >= nu * AUTO_GREY_FRAC) { greyC = c; break; } }
  const hist = () => [0, 1, 2].map(() => new Uint32Array(256));
  const lum = new Uint32Array(256), neu = hist();
  const v8 = (x) => Math.round(255 * linearToSrgb(clamp(x, 0, 1)));
  let nn = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    lum[v8(0.2126729 * cur.lr[i] + 0.7151522 * cur.lg[i] + 0.072175 * cur.lb[i])]++;
    if (usable(i) && Math.hypot(cur.A[i], cur.B[i]) <= greyC) { neu[0][v8(cur.lr[i])]++; neu[1][v8(cur.lg[i])]++; neu[2][v8(cur.lb[i])]++; nn++; sa += cur.A[i]; sb += cur.B[i]; }
  }
  const pct = (h, total, q) => {
    const want = q * total;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= want) return v; }
    return 255;
  };

  const lo = pct(lum, n, 0.003), hi = pct(lum, n, 0.997);
  const bx = Math.round(clamp(lo - 2, 0, 24)), wx = Math.round(clamp(hi + 2, 230, 255));
  const st = (v) => clamp((v - bx) / (wx - bx) * 255, 0, 255);
  const q25 = pct(lum, n, 0.25), q50 = pct(lum, n, 0.5), q75 = pct(lum, n, 0.75);
  const ym = st(q50) + clamp((AUTO_MID - st(q50)) * 0.5, -18, 18);
  const push = clamp((AUTO_QSPREAD - (st(q75) - st(q25))) * 0.3, -8, 14);
  // Place the midpoint first, then the quartiles around it, each kept inside AUTO_SLOPE of the
  // points already placed on either side (a quartile that can't fit is left out). The midpoint
  // wins, so contrast never undoes the brightness correction.
  const [sLo, sHi] = AUTO_SLOPE;
  const curve = [[bx, 0], [wx, 255]];
  const place = (x, y) => {
    const j = curve.findIndex((q) => q[0] > x);
    if (j < 1) return;
    const [x0, y0] = curve[j - 1], [x1, y1] = curve[j];
    if (x - x0 < 12 || x1 - x < 12) return;
    const lo = Math.max(y0 + sLo * (x - x0), y1 - sHi * (x1 - x)), hi = Math.min(y0 + sHi * (x - x0), y1 - sLo * (x1 - x));
    if (lo <= hi) curve.splice(j, 0, [x, Math.round(clamp(y, lo, hi))]);
  };
  place(q50, ym);
  place(q25, st(q25) - push);
  place(q75, st(q75) + push);
  // exposure was lifted: pull the highlights down first so the lift stays balanced (kept inside AUTO_SLOPE)
  const roll = highlightRollOff(params.exposure || 0);
  if (roll) {
    const hx = Math.round((Math.max(q75, 150) + wx) / 2), M0 = curveLUT(curve);
    place(hx, Math.round(255 * M0[Math.round(hx / 255 * 1023)]) - roll);
  }

  // channel curves sit after the light curve, so measure through it (percentiles survive a monotone map)
  const M = curveLUT(curve);
  const lit = (v) => 255 * M[Math.round(v / 255 * 1023)];
  const warm = nn && sb / nn > 0 && sa / nn > -2;
  const k = nn >= n * 0.02 ? 0.8 * clamp((AUTO_GREY_C[1] - greyC) / (AUTO_GREY_C[1] - AUTO_GREY_C[0]), 0, 1) * (warm ? 1 - AUTO_WARM_KEEP : 1) : 0;
  const anchors = [0.05, 0.5, 0.95].map((q) => neu.map((h) => lit(pct(h, nn, q))));
  const [curveR, curveG, curveB] = [0, 1, 2].map((c) => {
    const pts = [[0, 0]];
    for (const a of anchors) {
      const x = Math.round(a[c]), [px, py] = pts[pts.length - 1];
      const d = clamp(((a[0] + a[1] + a[2]) / 3 - a[c]) * k, -AUTO_RGB_MAX, AUTO_RGB_MAX);
      if (Math.abs(d) < 1.5 || x < 10 || x > 245 || x - px < 16) continue;
      pts.push([x, Math.round(clamp(x + d, py + 4, 251))]);
    }
    pts.push([255, 255]);
    return pts;
  });
  return { curve, curveR, curveG, curveB };
}

const handlers = {
  async measureRef({ file }) {
    const e = { file };
    const bmp = await openBitmap(e);
    await analyze(e, bmp);
    const stats = measure(e.ps);
    stats.scene = e.scene;
    stats.regions = regionStats(e.ps);
    stats.maskedRegions = referenceRegionTargets(e.ps);
    stats.matchVersion = 3;
    stats.signature = { halation: halationSignature(e.ps) };
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
    let cull = null;
    try { cull = cullInfo(e, bmp); } catch (err) { console.warn('cull info failed', err); }
    bmp.close();
    touch(id);
    return { stats: measure(e.ps), thumb, cull, width: e.fullW, height: e.fullH, scene: e.scene, faces: e.faces ? e.faces.length : null, faceErr: e.faces ? null : faceError(), converted: e.converted || null, mask: maskInfo(e) };
  },

  // subject mask edits. op: 'add' / 'remove' (the object under x, y: 0..1 of the photo as shown, after
  // crop and level), 'auto' (people on or off: on), 'undo' (last tap), 'clear' (all taps).
  async mask({ id, op, x, y, on }) {
    const e = cache.get(id);
    if (!e) throw new Error('photo not loaded');
    const bmp = await openBitmap(e, id);
    try {
      if (op === 'retry') {
        // the models failed to start: give them fresh attempts, then find faces and people again
        segmenter.retry(); landmarker.retry(); peopleLandmarker.retry();
        if (e.faces === null) e.faces = undefined;
        if (e.mask && !e.mask.ok) e.mask = undefined;
        await analyze(e, bmp);
        touch(id);
        return { mask: maskInfo(e), before: measure(e.ps), faces: e.faces ? e.faces.length : null, faceErr: e.faces ? null : faceError() };
      }
      if (e.mask === undefined) await ensureMask(e, bmp);
      const M = e.mask;
      if (op === 'add' || op === 'remove') {
        const W = bmp.width, H = bmp.height, g = e.geom;
        let fx = x, fy = y;
        if (!isIdentityGeom(g)) {
          const [sx, sy] = toSource((g.x + x * g.w) * W, (g.y + y * g.h) * H, W, H, g.angle || 0);
          fx = sx / W; fy = sy / H;
        }
        if (fx < 0 || fy < 0 || fx > 1 || fy > 1) throw new Error('That spot is outside the photo');
        const m = await tapMask(bmp, fx, fy);
        if (!m) throw new Error('The tap model did not load');
        let on = 0; for (let i = 0; i < m.data.length; i++) on += m.data[i];
        if (on / 255 / m.data.length < 0.0005) throw new Error('Nothing found there. Try tapping the middle of the thing.');
        M.picks.push({ add: op === 'add', x: fx, y: fy, data: m.data });
      } else if (op === 'auto') M.useAuto = !!on;
      else if (op === 'undo') M.picks.pop();
      else if (op === 'clear') M.picks = [];
      combineMask(e);
      await analyze(e, bmp); // re-measure with the new subject
    } finally { bmp.close(); }
    touch(id);
    return { mask: maskInfo(e), before: measure(e.ps) };
  },

  // Heal spots. op 'add': a new spot at (x, y) (0..1 of the photo as shown) with radius `size` (fraction of
  // the photo's long side), source picked automatically. op 'source': move spot `heal`'s source to (x, y).
  // Returns the spot in whole-photo coordinates; the app keeps the list in params.heals.
  async heal({ id, op, x, y, size = 0.015, opacity = 0.6, heal = null, side = 1200 }) {
    const e = await ensurePrepared(id);
    const g = e.geom, W = e.fullW, H = e.fullH;
    const [px, py] = outToPhoto(e, x, y, g);
    if (px < 0 || py < 0 || px > W || py > H) throw new Error('That spot is outside the photo');
    if (op === 'source') return { heal: { ...heal, sx: px / W, sy: py / H } };
    const d = await ensureDisplay(id, side, false); // same size as the preview, so its cached copy is reused
    const k = dispScale(e, d.width, g);
    const r = size * Math.max(W, H) * k;
    const skin = e.mask && e.mask.skinFrac >= 0.0005 ? maskFor(e, d.width, d.height, g, 0, null, 'skin') : null;
    const [sxd, syd] = pickHealSource(d.data, d.width, d.height, x * d.width, y * d.height, r, 4, skin);
    const [sx, sy] = outToPhoto(e, sxd / d.width, syd / d.height, g);
    return { heal: { x: px / W, y: py / H, r: size, sx: sx / W, sy: sy / H, op: opacity } };
  },

  // Point colour: the colour under (x, y) (0..1 of the photo as shown), as it comes out of the current
  // edit without point colours, in Lab.
  async samplePoint({ id, x, y, params, side = 1200 }) {
    const d = await ensureDisplay(id, side, false);
    const X = Math.round(x * (d.width - 1)), Y = Math.round(y * (d.height - 1)), rad = Math.max(2, Math.round(d.width / 250));
    const proc = compile({ ...params, points: [] });
    const res = new Float64Array(6), acc = [0, 0, 0];
    let n = 0;
    for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) {
      const u = X + i, v = Y + j;
      if (u < 0 || v < 0 || u >= d.width || v >= d.height) continue;
      const o = (v * d.width + u) * 4;
      proc(srgbToLinear(d.data[o] / 255), srgbToLinear(d.data[o + 1] / 255), srgbToLinear(d.data[o + 2] / 255), res);
      acc[0] += res[3]; acc[1] += res[4]; acc[2] += res[5]; n++;
    }
    if (!n) throw new Error('That spot is outside the photo');
    return { L: acc[0] / n, a: acc[1] / n, b: acc[2] / n };
  },

  // Tone-curve picker: sample the displayed point after the other settings, but before the selected curve.
  async sampleCurve({ id, x, y, params, curveKey, region = 'all', side = 1200 }) {
    if (!['curve', 'curveR', 'curveG', 'curveB'].includes(curveKey)) throw new Error('Unknown tone curve');
    const d = await ensureDisplay(id, side, false);
    const X = Math.round(x * (d.width - 1)), Y = Math.round(y * (d.height - 1)), rad = Math.max(2, Math.round(d.width / 250));
    let q;
    if (region === 'all') {
      q = { ...params };
      delete q[curveKey];
    } else {
      const loc = { ...((params.local && params.local[region]) || {}) };
      delete loc[curveKey];
      q = withLocal(params, loc);
    }
    const proc = compile(q), res = new Float64Array(6);
    let total = 0, n = 0;
    const ch = curveKey === 'curveR' ? 0 : curveKey === 'curveG' ? 1 : curveKey === 'curveB' ? 2 : -1;
    for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) {
      const u = X + i, v = Y + j;
      if (u < 0 || v < 0 || u >= d.width || v >= d.height) continue;
      const o = (v * d.width + u) * 4;
      proc(srgbToLinear(d.data[o] / 255), srgbToLinear(d.data[o + 1] / 255), srgbToLinear(d.data[o + 2] / 255), res);
      total += ch < 0 ? linearToSrgb(lToY(res[3])) : linearToSrgb(res[ch]);
      n++;
    }
    if (!n) throw new Error('That spot is outside the photo');
    return { value: Math.round(Math.min(1, Math.max(0, total / n)) * 255) };
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

  // Correct only measured problems; Auto Adjust is a starting correction, not a look. The basic
  // sliders stay gentle and the curves do the work: autoCurves fits the light curve and the R/G/B
  // curves to this photo as edited so far (white balance, HSL, local edits), minus its old curves.
  async autoAdjust({ id, params = {} }) {
    if (hasReferenceCurve(params)) {
      return autoAdjustResult(params);
    }
    const e = await ensurePrepared(id);
    const s = measure(e.ps), t = s.tone, p = t.pct;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const exposure = clamp(Math.log2(lToY(47) / Math.max(0.0001, lToY(p[50]))) * 0.24, -0.35, 0.35);
    // dark photos can take a bigger lift, because the curve below pulls the highlights down to balance it
    const lift = exposure > 0 ? clamp(exposure * 1.6, 0, 0.6) : exposure;
    const highlights = clamp(-(p[99] - 94) * 0.22 - (t.clipHi > 0.002 ? 3 : 0), -10, 0);
    const shadows = clamp((5 - p[5]) * 0.22 + (t.clipLo > 0.002 ? 3 : 0), 0, 7);
    const basic = { exposure: lift, contrast: 0, highlights, shadows, whites: 0, blacks: 0 };
    // white balance on skin, then saturation down / vibrance up (portrait rules)
    const cur0 = processPixelSet(e.ps, { ...params, ...basic });
    let sn = 0, sa = 0, sb = 0, cn = 0, cs = 0;
    const sk = e.ps.skinMask;
    for (let i = 0; i < e.ps.n; i++) {
      if (cur0.L[i] > 12 && cur0.L[i] < 95) { cs += Math.hypot(cur0.A[i], cur0.B[i]); cn++; }
      if (sk && sk[i] >= 191 && cur0.L[i] > 25 && cur0.L[i] < 92) { sa += cur0.A[i]; sb += cur0.B[i]; sn++; }
    }
    const wb = sn >= e.ps.n * 0.002 ? skinWhiteBalance(sa / sn, sb / sn) : { temp: 0, tint: 0 };
    Object.assign(basic, presenceFor(cn ? cs / cn : NaN), wb.temp || wb.tint ? { temp: clamp((params.temp || 0) + wb.temp, -60, 60), tint: clamp((params.tint || 0) + wb.tint, -50, 50) } : {});
    const curves = autoCurves(e.ps, { ...params, ...basic, curve: null, curveR: null, curveG: null, curveB: null });
    return autoAdjustResult(params, { ...basic, ...curves });
  },

  // modelUrl + refThumb (the reference's saved thumbnail) turn on model assist: the Deep Preset Space
  // restyles this photo toward the reference, and the solver then chases that result's measured
  // targets instead of the reference's own. Any failure falls back to the plain reference targets.
  async solve({ id, refStats, strength, lrParams = null, finish = 'off', finishStrength = 1, pull = 0.5, split = true, modelUrl = null, refThumb = null }) {
    const e = await ensurePrepared(id);
    const o = measure(e.ps);
    let model = null;
    if (modelUrl && refThumb && refStats && !lrParams) {
      try {
        const src = await openBitmap(e, id);
        const d = scaledData(src, SOLVE_SIDE, e.geom);
        src.close();
        const ref = await (await fetch(refThumb)).blob();
        const out = await stylizeRemote(modelUrl, await toJpegBlob(d, 0.92), ref);
        const bmp = await createImageBitmap(out);
        const r = scaledData(bmp, SOLVE_SIDE);
        bmp.close();
        if (r.width !== e.ps.width || r.height !== e.ps.height) throw new Error('Model returned a different size');
        const ps = prepare(r, { faces: mapPolys(e.faces, e.fullW, e.fullH, e.geom), subject: maskFor(e, r.width, r.height, e.geom), skin: maskFor(e, r.width, r.height, e.geom, 0, null, 'skin') });
        ps.skinPeople = maskFor(e, r.width, r.height, e.geom, 0, null, 'skinPeople') || new Uint8Array(ps.n);
        ps.skinPositions = mapPositions(e.mask?.skinPositions, e.fullW, e.fullH, e.geom);
        refStats = { ...measure(ps), maskedRegions: referenceRegionTargets(ps), scene: refStats.scene, regions: refStats.regions, signature: refStats.signature };
        model = { ok: true };
      } catch (err) { model = { ok: false, error: err.message }; }
    }
    // Masks are ready before fitting. Each region follows its own reference instead of correcting
    // a whole-photo match afterwards; missing masks retain the whole-photo fallback.
    const masked = !lrParams && split && refStats ? solveMaskedReference(e.ps, refStats, { strength, scene: e.scene }) : null;
    const res = masked || (lrParams
      ? solvePreset(e.ps, o, lrParams, { strength, scene: e.scene, pull })
      : solve(e.ps, o, refStats, { strength, scene: e.scene }));
    // Skin has its own measured color and brightness target inside the subject, before finishes.
    if (!lrParams && refStats?.skinMatch) {
      const match = fitSkinMatch(e.ps, processPixelSet(e.ps, res.params), refStats.skinMatch, { move: Math.min(1, strength ?? 1) * 0.65 });
      if (match) res.params.skinMatch = match;
    }
    if (!lrParams && refStats && refStats.signature && refStats.signature.halation > 0) {
      res.params.halation = Math.round(Math.min(60, refStats.signature.halation * Math.min(1, strength)));
    }
    let style = null;
    const prof = finish && finish !== 'off' ? FINISH_PROFILES[finish] : null;
    if (prof) {
      const f = fitFinish(e.ps, res.params, prof, null, { strength: finishStrength });
      res.params = f.params; style = f.style;
    }
    // subject vs background: the photographer's similar published photos, else the reference's own split
    let regions = masked?.regions || null;
    if (!masked && split && e.ps.subject) {
      let want = null, move = REGION_MOVE, from = null;
      if (prof && prof.data) {
        want = nearestRegions(prof.data, signature(e.ps.L, e.ps.A, e.ps.B, e.ps.width, e.ps.height), !(style && style.mono));
        move *= Math.min(1.5, finishStrength); from = want ? { kind: 'photographer', name: prof.name, k: want.k, n: want.n } : null;
      }
      if (!want && refStats && regionUsable(refStats.regions)) {
        want = refStats.regions; move = REF_REGION.move * Math.min(1, strength); from = { kind: 'reference' };
      }
      if (want && move > 0) {
        const r = from && from.kind === 'reference' && want.subject && want.subject.tone && want.background && want.background.bands
          ? fitReferenceRegions(e.ps, res.params, want, { ...REF_REGION, move })
          : fitRegions(e.ps, res.params, want, from && from.kind === 'reference' ? { ...REF_REGION, move } : { move });
        if (r) { res.params = r.params; regions = { ...r.regions, from }; }
      }
    }
    const cur = processPixelSet(e.ps, res.params);
    const after = measure(e.ps, cur);
    const loss = lossReport(e.ps, cur, res.params);
    return { model, params: res.params, targets: res.targets, before: o, after, loss, scene: e.scene, timings: res.timings, guardScale: res.guardScale, style, regions, mask: maskInfo(e) };
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
      const keys = SLIDERS.map((s) => s.key);
      if (hasLocal(params) && e.ps.subject) for (const r of REGIONS) for (const s of LOCAL_SLIDERS) keys.push(`${r}:${s.key}`);
      loss.culprits = culprits(e.ps, params, (q, idx, c) => processPixelSet(e.ps, q, idx, c), e.sample, scratch, keys, auto);
    }
    return { after: measure(e.ps, cur), loss };
  },

  // plain: the whole photo without crop/level (the crop tool draws its own frame over it)
  // showMask: 'subject' / 'background' paints that region red over the edit
  async preview({ id, params, side = 1400, withOriginal = false, overlay = false, plain = false, showMask = null }) {
    const d = await ensureDisplay(id, side, plain);
    const e = cache.get(id);
    let mask = null;
    if ((hasLocal(params) || showMask) && e.mask) {
      const key = `${e.mask.ver}`;
      if (d.maskKey !== key) { d.mask = maskFor(e, d.width, d.height, plain ? null : e.geom); d.maskKey = key; }
      mask = d.mask;
    }
    let skin = null, people = null, heals = null;
    if ((hasSkinPass(params) || params.skinMatch) && e.mask) {
      const key = `${e.mask.ver}`;
      if (d.skinKey !== key) { d.skin = maskFor(e, d.width, d.height, plain ? null : e.geom, 0, null, 'skin'); d.skinKey = key; }
      skin = d.skin;
    }
    if (params.skinMatch && e.mask) {
      const key = `${e.mask.ver}|${plain ? 'plain' : geomKey(e.geom)}`;
      if (d.skinPeopleKey !== key) { d.skinPeople = maskFor(e, d.width, d.height, plain ? null : e.geom, 0, null, 'skinPeople'); d.skinPeopleKey = key; }
      people = d.skinPeople;
    }
    if (hasHeals(params)) { const g = plain ? null : e.geom; heals = healsToOut(params.heals, e.fullW, e.fullH, g, dispScale(e, d.width, g)); }
    const out = renderInto(d, params, mask, skin, heals, people);
    if (overlay) paintClipping(d.data, out.data);
    if (showMask && mask) paintMask(out.data, mask, showMask);
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
    const luts = buildLUTs(params, 33);
    const masked = !luts.lut && e.mask && e.mask.frac >= 0.0005;
    const rgba = new Uint8ClampedArray(OW * OH * 4);
    // the skin pass blurs, so each band is rendered with `halo` rows of context above and below
    const long = Math.max(OW, OH);
    const skinOn = hasSkinPass(params) && e.mask && e.mask.skinFrac >= 0.0005;
    const glowHalo = params.halation ? halationRadius(OW, OH) : 0;
    const halo = Math.max(skinOn ? skinHalo(long) : 0, glowHalo);
    // tiles keep each canvas well under iOS Safari's ~16.7 MP canvas limit
    const tileH = Math.max(64, Math.min(OH, Math.floor(4_000_000 / OW) - 2 * halo));
    const [c, x] = canvas(OW, Math.min(OH, tileH + 2 * halo));
    x.imageSmoothingQuality = 'high';
    const healed = hasHeals(params) ? healPatches(bmp, g, OW, OH, healsToOut(params.heals, W, H, g, 1, 0)) : null;
    for (let y = 0; y < OH; y += tileH) {
      const h = Math.min(tileH, OH - y);
      const ya = Math.max(0, y - halo), hh = Math.min(OH, y + h + halo) - ya;
      drawBand(x, bmp, g, OW, c.height, ya, hh);
      const d = x.getImageData(0, 0, OW, hh).data;
      if (healed) pasteHealed(d, OW, hh, ya, healed);
      const band = rgba.subarray(y * OW * 4, (y + h) * OW * 4);
      if (!halo) {
        applyLUTs(luts, masked ? maskFor(e, OW, h, g, y, 1) : null, d, band, OW * h, 4, 4, 1 + y);
        if (params.skinMatch) applySkinMatchRGBA(band, params.skinMatch, maskFor(e, OW, h, g, y, 1, 'skin'), 4,
          maskFor(e, OW, h, g, y, 1, 'skinPeople'), d);
      }
      else {
        const tmp = new Uint8ClampedArray(OW * hh * 4);
        applyLUTs(luts, masked ? maskFor(e, OW, hh, g, ya, 1) : null, d, tmp, OW * hh, 4, 4, 1 + ya);
        if (params.skinMatch) applySkinMatchRGBA(tmp, params.skinMatch, maskFor(e, OW, hh, g, ya, 1, 'skin'), 4,
          maskFor(e, OW, hh, g, ya, 1, 'skinPeople'), d);
        if (skinOn) applySkinPass(tmp, OW, hh, params, maskFor(e, OW, hh, g, ya, 1, 'skin'), long, 4, y - ya, y - ya + h);
        if (params.halation) applyHalation(tmp, OW, hh, params.halation, ya, OW, OH, glowHalo);
        band.set(tmp.subarray((y - ya) * OW * 4, (y - ya + h) * OW * 4));
      }
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

  // On-device check of what face, people and skin detection depend on, one row per step, for Settings.
  async visionCheck() {
    const rows = [];
    const step = async (name, fn) => {
      const t0 = performance.now();
      try {
        const d = await fn();
        rows.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), detail: d == null ? '' : String(d) });
        return true;
      } catch (err) {
        rows.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), detail: String((err && err.message) || err) });
        return false;
      }
    };
    const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    await step('worker', () => {
      // the test MediaPipe makes to decide whether it can use OffscreenCanvas (else it reaches for `document`)
      const ua = navigator.userAgent, safari = ua.includes('Safari') && !ua.includes('Chrome'), ver = (ua.match(/Version\/(\d+).*Safari/) || [])[1];
      const canvasOk = typeof OffscreenCanvas === 'function' && (!safari || Number(ver) >= 17);
      return `${MP_BUILD}; importScripts ${typeof importScripts}; OffscreenCanvas ${typeof OffscreenCanvas}; MediaPipe sees ${safari ? `Safari ${ver ?? 'without a version number'}` : 'not Safari'}, so ${canvasOk ? 'uses OffscreenCanvas' : 'falls back to document'}; wasm simd ${WebAssembly.validate(simd)}; ${navigator.hardwareConcurrency} cores; ${ua}`;
    });
    await step('webgl2 in worker', () => {
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
      if (!gl) throw new Error('no webgl2 context');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const ext = ['EXT_color_buffer_float', 'OES_texture_float_linear', 'EXT_float_blend'].filter((n) => gl.getExtension(n));
      return `${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'renderer hidden'}; ${ext.join(', ') || 'no float extensions'}`;
    });
    await step('download models', async () => {
      const out = [];
      for (const f of ['models/face_landmarker.task', 'models/selfie_multiclass_256x256.tflite', 'vendor/mediapipe/wasm/vision_wasm_module_internal.wasm']) {
        const r = await fetch(new URL('./' + f, import.meta.url));
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        out.push(`${f.split('/').pop()} ${((await r.arrayBuffer()).byteLength / 1048576).toFixed(1)} MB`);
      }
      return out.join(', ');
    });
    await step('wasm loader', async () => { const m = await import(LOADER); return `default export is a ${typeof m.default}; ${WASM.split('/').slice(-3).join('/')}`; });
    const started = async (get, err) => {
      get.retry();
      const t = await get();
      if (!t) throw new Error((visionErrors[err] && `${visionErrors[err].message}${visionErrors[err].stack ? '\n' + visionErrors[err].stack : ''}`) || "didn't start");
      return t;
    };
    const blank = () => { const c = new OffscreenCanvas(256, 256), x = c.getContext('2d'); x.fillStyle = '#887766'; x.fillRect(0, 0, 256, 256); return x.getImageData(0, 0, 256, 256); };
    let lm = null, seg = null;
    if (await step('face model starts', async () => { lm = await started(landmarker, 'face'); return 'ok'; })) {
      await step('face model runs', () => `${lm.detect(blank()).faceLandmarks.length} faces in a blank frame`);
    }
    if (await step('people model starts', async () => { seg = await started(segmenter, 'person'); return 'ok'; })) {
      await step('people model runs', () => {
        const r = seg.segment(blank());
        try { const m = r.confidenceMasks[0], a = m.getAsFloat32Array(); return `mask ${m.width}x${m.height}, ${a.length} values read`; } finally { r.close(); }
      });
    }
    return { rows, cores: navigator.hardwareConcurrency };
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
