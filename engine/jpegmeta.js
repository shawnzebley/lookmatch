// Minimal JPEG segment handling: copy EXIF (orientation reset), embed/replace XMP.

function segments(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  const segs = [];
  let i = 2;
  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xff) break;
    const marker = u8[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    segs.push({ marker, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return segs;
}

const EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0];
const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';

function startsWith(u8, off, arr) { for (let k = 0; k < arr.length; k++) if (u8[off + k] !== arr[k]) return false; return true; }

// Returns the APP1 Exif segment bytes (marker..end) with Orientation set to 1, or null.
export function exifSegment(u8) {
  const segs = segments(u8);
  if (!segs) return null;
  const s = segs.find((g) => g.marker === 0xe1 && startsWith(u8, g.start + 4, EXIF));
  if (!s) return null;
  const seg = u8.slice(s.start, s.end);
  try {
    const t = 10; // TIFF header offset inside segment
    const le = seg[t] === 0x49;
    const r16 = (o) => (le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1]);
    const r32 = (o) => (le ? (seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16) | (seg[o + 3] << 24)) >>> 0 : ((seg[o] << 24) | (seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]) >>> 0);
    const ifd = t + r32(t + 4);
    const n = r16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (r16(e) === 0x0112) { if (le) { seg[e + 8] = 1; seg[e + 9] = 0; } else { seg[e + 8] = 0; seg[e + 9] = 1; } }
    }
  } catch (e) { /* leave EXIF as is */ }
  return seg;
}

export function xmpSegment(packet) {
  const enc = new TextEncoder();
  const ns = enc.encode(XMP_NS), body = enc.encode(packet);
  const len = 2 + ns.length + body.length;
  if (len > 65535) throw new Error('XMP too large');
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = len >> 8; seg[3] = len & 255;
  seg.set(ns, 4); seg.set(body, 4 + ns.length);
  return seg;
}

// Insert segments right after SOI (and after APP0/JFIF if present). Optionally drop existing XMP.
export function insertSegments(u8, add, { dropXmp = false, dropExif = false } = {}) {
  const segs = segments(u8) || [];
  const enc = new TextEncoder();
  const ns = enc.encode(XMP_NS);
  const drop = segs.filter((g) => g.marker === 0xe1 && ((dropXmp && startsWith(u8, g.start + 4, ns)) || (dropExif && startsWith(u8, g.start + 4, EXIF))));
  let insertAt = 2;
  const app0 = segs.find((g) => g.marker === 0xe0);
  if (app0 && app0.start === 2) insertAt = app0.end;
  const parts = [u8.subarray(0, insertAt), ...add];
  let cur = insertAt;
  for (const d of drop.sort((a, b) => a.start - b.start)) {
    if (d.start < cur) continue;
    parts.push(u8.subarray(cur, d.start));
    cur = d.end;
  }
  parts.push(u8.subarray(cur));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function isJpeg(u8) { return u8[0] === 0xff && u8[1] === 0xd8; }
