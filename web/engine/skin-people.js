const MIN_PERSON_PROBABILITY = 0.55;
const MIN_WIN_MARGIN = 0.15;
const FACE_MATCH_DISTANCE = 0.12;

function faceCenter(face) {
  const points = Array.isArray(face) ? face : face?.points;
  if (!points?.length) return null;
  return points.reduce((p, v) => [p[0] + v[0] / points.length, p[1] + v[1] / points.length], [0, 0]);
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function maskValue(mask, i) {
  const value = mask?.[i] ?? 0;
  return mask instanceof Uint8Array || mask instanceof Uint8ClampedArray ? value / 255 : value;
}

/** Assign stable per-image ids to confident pose masks and conservative face-only fallbacks. */
export function assignPeople({ width, height, poseMasks = [], positions = [], faces = [], skin = null }) {
  const n = width * height;
  const labels = new Uint8Array(n);
  const personPositions = positions.map((p, i) => ({ id: p.id ?? i + 1, x: p.x, y: p.y, scope: 'person', poseIndex: i }));
  let ambiguous = 0;

  for (let i = 0; i < n; i++) {
    let best = -1, bestP = -Infinity, nextP = -Infinity;
    for (let j = 0; j < poseMasks.length; j++) {
      const p = maskValue(poseMasks[j], i);
      if (p > bestP) { nextP = bestP; bestP = p; best = j; }
      else if (p > nextP) nextP = p;
    }
    if (bestP < MIN_PERSON_PROBABILITY) continue;
    if (bestP - nextP < MIN_WIN_MARGIN) { ambiguous++; continue; }
    const id = personPositions[best]?.id;
    if (id > 0 && id <= 255) labels[i] = id;
  }

  const matchedPoses = new Set();
  let nextId = Math.max(0, ...personPositions.map((p) => p.id)) + 1;
  for (const face of faces) {
    const center = faceCenter(face);
    if (!center) continue;
    let best = -1, distance = Infinity;
    for (let i = 0; i < personPositions.length; i++) {
      const p = personPositions[i];
      if (matchedPoses.has(i)) continue;
      const d = Math.hypot((p.x - center[0]) * width, (p.y - center[1]) * height) / Math.max(width, height);
      if (d < distance) { distance = d; best = i; }
    }
    if (best >= 0 && distance <= FACE_MATCH_DISTANCE) {
      matchedPoses.add(best);
      continue;
    }

    // A face-only fallback labels only its facial polygon, optionally intersected with skin.
    // It never expands to the surrounding person's clothes or body.
    const id = nextId++;
    if (id > 255) continue;
    const points = Array.isArray(face) ? face : face.points;
    personPositions.push({ id, x: center[0], y: center[1], scope: 'face' });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (insidePolygon((x + 0.5) / width, (y + 0.5) / height, points) && (!skin || skin[i] > 0)) labels[i] = id;
    }
  }
  return { labels, positions: personPositions, ambiguous };
}
