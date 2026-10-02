const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function personProbabilities({ hair = null, body = null, face = null, clothes = null, accessories = null, width = null, height = null }) {
  const n = [hair, body, face, clothes, accessories].find(Boolean)?.length || 0;
  const foreground = new Float32Array(n), skin = new Float32Array(n), core = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    core[i] = clamp01((hair?.[i] || 0) + (body?.[i] || 0) + (face?.[i] || 0) + (clothes?.[i] || 0));
    skin[i] = clamp01((body?.[i] || 0) + (face?.[i] || 0));
  }
  const w = width && height && width * height === n ? width : n;
  const h = w === n ? 1 : height;
  const nearbyPerson = accessories && w * h === n
    ? supportMask(core, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.01)), 0.15)
    : null;
  for (let i = 0; i < n; i++) foreground[i] = clamp01(core[i] + (nearbyPerson?.[i] ? accessories[i] || 0 : 0));
  return { foreground, skin };
}

function maxFilterLine(src, out, length, srcOffset, srcStride, outOffset, outStride, radius) {
  const deque = new Int32Array(length);
  let head = 0, tail = 0, added = -1;
  for (let i = 0; i < length; i++) {
    const end = Math.min(length - 1, i + radius);
    while (added < end) {
      const j = ++added, value = src[srcOffset + j * srcStride];
      while (tail > head && src[srcOffset + deque[tail - 1] * srcStride] <= value) tail--;
      deque[tail++] = j;
    }
    const start = i - radius;
    while (tail > head && deque[head] < start) head++;
    out[outOffset + i * outStride] = src[srcOffset + deque[head] * srcStride];
  }
}

function supportMask(base, width, height, radius, threshold) {
  const binary = new Uint8Array(base.length), horizontal = new Uint8Array(base.length), out = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) binary[i] = base[i] >= threshold ? 1 : 0;
  for (let y = 0; y < height; y++) maxFilterLine(binary, horizontal, width, y * width, 1, y * width, 1, radius);
  for (let x = 0; x < width; x++) maxFilterLine(horizontal, out, height, x, width, x, width, radius);
  return out;
}

/** Blend a close crop into a full-frame probability only near existing person evidence. */
export function fuseCropProbabilities(base, crop, width, height, { x0, y0, cropWidth, cropHeight, fade, supportRadius, supportThreshold = 0.35 }) {
  const support = supportMask(base, width, height, supportRadius, supportThreshold);
  const inf = 1e9;
  for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
    const edge = Math.min(x0 > 0 ? x : inf, y0 > 0 ? y : inf,
      x0 + cropWidth < width ? cropWidth - 1 - x : inf,
      y0 + cropHeight < height ? cropHeight - 1 - y : inf);
    const t = Math.min(1, edge / fade);
    if (t <= 0) continue;
    const i = (y0 + y) * width + x0 + x;
    if (!support[i]) continue;
    base[i] = clamp01(base[i] + (crop[y * cropWidth + x] - base[i]) * t);
  }
  return base;
}
