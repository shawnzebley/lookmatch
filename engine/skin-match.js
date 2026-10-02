import { linToLab, labToLin, linearToSrgb, SRGB8_TO_LIN } from './color.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeL = (L) => smooth(12, 30, L) * (1 - smooth(80, 95, L));
const ZONE_NAMES = ['shadow', 'midtone', 'lit'];
const LIMITS = { L: 12, a: 10, b: 12 };

function arrays(ps, cur) {
  return { L: cur?.L || ps?.L, a: cur?.A || cur?.a || ps?.A || ps?.a, b: cur?.B || cur?.b || ps?.B || ps?.b };
}
function median(values) {
  if (!values.length) return NaN;
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length & 1 ? values[m] : (values[m - 1] + values[m]) / 2;
}
function positionFor(ps, id) {
  const p = Array.isArray(ps.skinPositions) ? ps.skinPositions.find((item) => item.id === id) : ps.skinPositions instanceof Map ? ps.skinPositions.get(id) : ps.skinPositions?.[id];
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}

function summarize(values, L0 = null) {
  if (values.length < 20) return null;
  return { L: median(values.map((x) => x.L)), a: median(values.map((x) => x.a)), b: median(values.map((x) => x.b)), pixels: values.length, ...(L0 == null ? {} : { center: L0 }) };
}

function groupedSkinStats(ps, v) {
  if (!ps.skinPeople || !ps.L) return [];
  const groups = new Map();
  for (let i = 0; i < ps.skinMask.length; i++) {
    const id = ps.skinPeople[i];
    if (!id || ps.skinMask[i] < 191 || !Number.isFinite(ps.L[i]) || !Number.isFinite(v.L?.[i]) || !Number.isFinite(v.a?.[i]) || !Number.isFinite(v.b?.[i])) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ originalL: ps.L[i], L: v.L[i], a: v.a[i], b: v.b[i] });
  }
  const people = [];
  for (const [id, pixels] of groups) {
    if (pixels.length < 20) continue;
    const sorted = pixels.map((p) => p.originalL).sort((a, b) => a - b);
    const q33 = sorted[Math.floor((sorted.length - 1) / 3)], q67 = sorted[Math.floor(2 * (sorted.length - 1) / 3)];
    const zones = {};
    if (q33 === q67) {
      const z = summarize(pixels.map(({ L, a, b }) => ({ L, a, b })), median(sorted));
      if (z) zones.midtone = z;
    } else {
      const buckets = { shadow: [], midtone: [], lit: [] };
      for (const p of pixels) buckets[p.originalL <= q33 ? 'shadow' : p.originalL > q67 ? 'lit' : 'midtone'].push({ L: p.L, a: p.a, b: p.b });
      for (const name of ZONE_NAMES) {
        const bucket = buckets[name];
        const z = summarize(bucket, bucket.length ? median(pixels.filter((p) => name === 'shadow' ? p.originalL <= q33 : name === 'lit' ? p.originalL > q67 : p.originalL > q33 && p.originalL <= q67).map((p) => p.originalL)) : null);
        if (z) zones[name] = z;
      }
    }
    people.push({ id, position: positionFor(ps, id), pixels: pixels.length, L: median(pixels.map((p) => p.L)), a: median(pixels.map((p) => p.a)), b: median(pixels.map((p) => p.b)), zones });
  }
  return people.sort((a, b) => Number(a.id) - Number(b.id));
}

export function skinStats(ps, cur = ps, idx = null) {
  const mask = ps?.skinMask, v = arrays(ps, cur);
  if (!mask || !v.L || !v.a || !v.b) return null;
  const ls = [], as = [], bs = [];
  const add = (i) => {
    if (i >= 0 && i < mask.length && mask[i] >= 191 && Number.isFinite(v.L[i]) && Number.isFinite(v.a[i]) && Number.isFinite(v.b[i])) {
      ls.push(v.L[i]); as.push(v.a[i]); bs.push(v.b[i]);
    }
  };
  if (idx) for (const i of idx) add(i); else for (let i = 0; i < mask.length; i++) add(i);
  if (ls.length < 20) return null;
  const stats = { L: median(ls), a: median(as), b: median(bs), pixels: ls.length };
  const people = groupedSkinStats(ps, v);
  if (ps.skinPeople) { stats.version = 2; stats.people = people; }
  return stats;
}

// Globally minimum-distance one-to-one matching. When there are more source than reference people,
// each reference is paired once with the closest feasible source; ties follow sorted ids.
function pairPeople(source, reference) {
  if (reference.length === 1) return source.map((s) => [s, reference[0]]);
  const a = source.filter((p) => p.position), b = reference.filter((p) => p.position);
  if (!a.length || !b.length) return [];
  const rowsAreSource = a.length <= b.length, rows = rowsAreSource ? a : b, cols = rowsAreSource ? b : a;
  // Hungarian algorithm for a rectangular matrix (rows <= columns).
  const n = rows.length, m = cols.length, u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  const cost = (i, j) => {
    const x = rows[i].position.x - cols[j].position.x, y = rows[i].position.y - cols[j].position.y;
    return x * x + y * y;
  };
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const pairs = [];
  for (let j = 1; j <= m; j++) if (p[j]) pairs.push(rowsAreSource ? [rows[p[j] - 1], cols[j - 1]] : [cols[j - 1], rows[p[j] - 1]]);
  return pairs.sort((x, y) => Number(x[0].id) - Number(y[0].id));
}

function fitZone(ps, cur, indices, target, move, zoneName, center) {
  if (!target || target.pixels < 20) return null;
  const v = arrays(ps, cur), before = summarize(indices.map((i) => ({ L: v.L[i], a: v.a[i], b: v.b[i] })), center);
  if (!before) return null;
  const delta = { L: 0, a: 0, b: 0 }, goal = {};
  for (const k of ['L', 'a', 'b']) goal[k] = before[k] + (target[k] - before[k]) * move;
  for (let iteration = 0; iteration < 4 && move > 0; iteration++) {
    const sim = indices.map((i) => {
      const w = easeL(ps.L[i]);
      const l = clamp(v.L[i] + delta.L * w, 0, 100);
      const a = v.a[i] + delta.a * w, b = v.b[i] + delta.b * w;
      let rgb = labToLin(l, a, b, [0, 0, 0]);
      if (!inGamut(rgb)) {
        let lo = 0, hi = 1;
        for (let n = 0; n < 18; n++) { const mid = (lo + hi) / 2; if (inGamut(labToLin(l, a * mid, b * mid, [0, 0, 0]))) lo = mid; else hi = mid; }
        rgb = labToLin(l, a * lo, b * lo, [0, 0, 0]);
      }
      const lab = [0, 0, 0]; linToLab(...rgb, lab);
      return { L: lab[0], a: lab[1], b: lab[2] };
    });
    const got = { L: median(sim.map((x) => x.L)), a: median(sim.map((x) => x.a)), b: median(sim.map((x) => x.b)) };
    for (const k of ['L', 'a', 'b']) delta[k] = clamp(delta[k] + goal[k] - got[k], -LIMITS[k], LIMITS[k]);
  }
  return { name: zoneName, center, deltaL: delta.L, deltaA: delta.a, deltaB: delta.b, target: { L: target.L, a: target.a, b: target.b }, before };
}

function personIndices(ps, id) {
  const out = [];
  for (let i = 0; i < ps.skinMask.length; i++) if (ps.skinPeople[i] === id && ps.skinMask[i] >= 191 && Number.isFinite(ps.L[i])) out.push(i);
  return out;
}

export function fitSkinMatch(ps, cur, target, { move = 0.65 } = {}) {
  if (!Number.isFinite(move) || !target) return null;
  const m = clamp(move, 0, 1);
  const stats = skinStats(ps, cur);
  if (target.version === 2 && !stats?.people?.length) return null;
  if (!stats) return null;
  if (stats.people?.length && Array.isArray(target.people)) {
    const people = [];
    for (const [source, reference] of pairPeople(stats.people, target.people)) {
      const indices = personIndices(ps, source.id), zones = [];
      for (const name of ZONE_NAMES) {
        const srcZone = source.zones[name], refZone = reference.zones?.[name];
        if (!srcZone || !refZone) continue;
        const q33 = indices.length ? [...indices].map((i) => ps.L[i]).sort((a, b) => a - b)[Math.floor((indices.length - 1) / 3)] : 0;
        const q67 = indices.length ? [...indices].map((i) => ps.L[i]).sort((a, b) => a - b)[Math.floor(2 * (indices.length - 1) / 3)] : 0;
        const zoneIndices = indices.filter((i) => q33 === q67 ? name === 'midtone' : name === 'shadow' ? ps.L[i] <= q33 : name === 'lit' ? ps.L[i] > q67 : ps.L[i] > q33 && ps.L[i] <= q67);
        const fit = fitZone(ps, cur, zoneIndices, refZone, m, name, srcZone.center);
        if (fit) zones.push(fit);
      }
      if (zones.length) people.push({ id: source.id, referenceId: reference.id, zones });
    }
    return { version: 2, people, targets: people.map((p) => ({ id: p.id, referenceId: p.referenceId, zones: p.zones.map((z) => z.name) })) };
  }
  if (!['L', 'a', 'b'].every((k) => Number.isFinite(target[k])) || (target.pixels != null && target.pixels < 20)) return null;
  const v = arrays(ps, cur), indices = [];
  for (let i = 0; i < ps.skinMask.length; i++) if (ps.skinMask[i] >= 191 && Number.isFinite(v.L[i]) && Number.isFinite(v.a[i]) && Number.isFinite(v.b[i])) indices.push(i);
  const before = stats, delta = { L: 0, a: 0, b: 0 };
  for (let iteration = 0; iteration < 4 && m > 0; iteration++) {
    const got = { L: median(indices.map((i) => clamp(v.L[i] + delta.L * easeL(v.L[i]), 0, 100))), a: median(indices.map((i) => v.a[i] + delta.a * easeL(v.L[i]))), b: median(indices.map((i) => v.b[i] + delta.b * easeL(v.L[i]))) };
    for (const k of ['L', 'a', 'b']) delta[k] = clamp(delta[k] + (before[k] + (target[k] - before[k]) * m - got[k]), -LIMITS[k], LIMITS[k]);
  }
  return { deltaL: delta.L, deltaA: delta.a, deltaB: delta.b, target: { L: target.L, a: target.a, b: target.b }, before };
}

const PROFILE_CACHE = new WeakMap();
const LAB_TMP = [0, 0, 0], RGB_TMP = [0, 0, 0], CORRECTION_TMP = [0, 0, 0];
const EMPTY_ZONES = [];

function compileProfile(person, index) {
  const source = person.zones || EMPTY_ZONES, sorted = source.filter((z) => Number.isFinite(z.center)).slice().sort((a, b) => a.center - b.center);
  const n = sorted.length, centers = new Float64Array(n), dl = new Float64Array(n), da = new Float64Array(n), db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = sorted[i]; centers[i] = z.center; dl[i] = z.deltaL || 0; da[i] = z.deltaA || 0; db[i] = z.deltaB || 0;
    if (i) {
      const cap = Math.max(1, centers[i] - centers[i - 1]) * 0.35;
      dl[i] = clamp(dl[i], dl[i - 1] - cap, dl[i - 1] + cap);
      da[i] = clamp(da[i], da[i - 1] - cap, da[i - 1] + cap);
      db[i] = clamp(db[i], db[i - 1] - cap, db[i - 1] + cap);
    }
  }
  return { person, index, source, rawZones: source.slice(), refs: sorted, centers, dl, da, db };
}

function profileIsCurrent(profile, person, people) {
  if (profile.person !== person || people[profile.index] !== person || profile.source !== (person.zones || EMPTY_ZONES)) return false;
  const source = profile.source, refs = profile.refs;
  // Avoid a sort/copy per pixel while still detecting in-place slider edits and reorderings.
  if (source.length !== profile.rawZones.length) return false;
  let finiteCount = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== profile.rawZones[i]) return false;
    if (Number.isFinite(source[i].center)) finiteCount++;
  }
  if (finiteCount !== refs.length) return false;
  for (let i = 0; i < refs.length; i++) {
    const z = refs[i];
    if (!Number.isFinite(z.center)) return false;
    if (!Object.is(profile.centers[i], z.center) ||
        !Object.is(profile.rawDL[i], z.deltaL || 0) ||
        !Object.is(profile.rawDA[i], z.deltaA || 0) ||
        !Object.is(profile.rawDB[i], z.deltaB || 0)) return false;
  }
  return true;
}

function getProfile(match, personId) {
  const people = match.people;
  if (!people) return null;
  let cache = PROFILE_CACHE.get(match);
  if (!cache || cache.people !== people) { cache = { people, byId: new Map() }; PROFILE_CACHE.set(match, cache); }
  let profile = cache.byId.get(personId);
  if (profile && profile.person.id === personId && profileIsCurrent(profile, profile.person, people)) return profile;
  let person = null, personIndex = -1;
  for (let i = 0; i < people.length; i++) if (people[i].id === personId) { person = people[i]; personIndex = i; break; }
  if (!person) { cache.byId.delete(personId); return null; }
  profile = compileProfile(person, personIndex);
  // Keep original deltas for fast mutation validation; compiled arrays contain slope-limited deltas.
  profile.rawDL = new Float64Array(profile.refs.length); profile.rawDA = new Float64Array(profile.refs.length); profile.rawDB = new Float64Array(profile.refs.length);
  for (let i = 0; i < profile.refs.length; i++) { profile.rawDL[i] = profile.refs[i].deltaL || 0; profile.rawDA[i] = profile.refs[i].deltaA || 0; profile.rawDB[i] = profile.refs[i].deltaB || 0; }
  cache.byId.set(personId, profile);
  return profile;
}

function correctionFor(profile, originalL, out) {
  const n = profile.centers.length;
  if (!n) return false;
  if (n === 1 || originalL <= profile.centers[0]) { out[0] = profile.dl[0]; out[1] = profile.da[0]; out[2] = profile.db[0]; return true; }
  const last = n - 1;
  if (originalL >= profile.centers[last]) { out[0] = profile.dl[last]; out[1] = profile.da[last]; out[2] = profile.db[last]; return true; }
  let hi = 1;
  while (profile.centers[hi] < originalL) hi++;
  const t = (originalL - profile.centers[hi - 1]) / (profile.centers[hi] - profile.centers[hi - 1]);
  out[0] = profile.dl[hi - 1] + (profile.dl[hi] - profile.dl[hi - 1]) * t;
  out[1] = profile.da[hi - 1] + (profile.da[hi] - profile.da[hi - 1]) * t;
  out[2] = profile.db[hi - 1] + (profile.db[hi] - profile.db[hi - 1]) * t;
  return true;
}

function inGamut(rgb) { return Number.isFinite(rgb[0]) && Number.isFinite(rgb[1]) && Number.isFinite(rgb[2]) && rgb[0] >= -1e-8 && rgb[0] <= 1 + 1e-8 && rgb[1] >= -1e-8 && rgb[1] <= 1 + 1e-8 && rgb[2] >= -1e-8 && rgb[2] <= 1 + 1e-8; }

export function applySkinMatchLinear(res, p, maskValue, personId = 0, originalL = null) {
  const m = clamp(Number(maskValue) || 0, 0, 255) / 255, match = p?.skinMatch;
  if (!m || !match) return res;
  let dl, da, db, light = originalL;
  if (match.version === 2) {
    if (!Number.isFinite(originalL)) return res;
    const profile = getProfile(match, personId);
    if (!profile || !correctionFor(profile, originalL, CORRECTION_TMP)) return res;
    dl = CORRECTION_TMP[0]; da = CORRECTION_TMP[1]; db = CORRECTION_TMP[2];
  } else { dl = match.deltaL || 0; da = match.deltaA || 0; db = match.deltaB || 0; }
  if (!(dl || da || db)) return res;
  linToLab(res[0], res[1], res[2], LAB_TMP);
  if (!Number.isFinite(light)) light = LAB_TMP[0];
  const weight = m * easeL(light);
  const L = clamp(LAB_TMP[0] + clamp(dl, -LIMITS.L, LIMITS.L) * weight, 0, 100);
  const a = LAB_TMP[1] + clamp(da, -LIMITS.a, LIMITS.a) * weight;
  const b = LAB_TMP[2] + clamp(db, -LIMITS.b, LIMITS.b) * weight;
  let rgb = labToLin(L, a, b, RGB_TMP);
  if (!inGamut(rgb)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(labToLin(L, a * mid, b * mid, RGB_TMP))) lo = mid; else hi = mid; }
    rgb = labToLin(L, a * lo, b * lo, RGB_TMP);
  }
  res[0] = clamp(rgb[0], 0, 1); res[1] = clamp(rgb[1], 0, 1); res[2] = clamp(rgb[2], 0, 1);
  linToLab(res[0], res[1], res[2], LAB_TMP); res[3] = LAB_TMP[0]; res[4] = LAB_TMP[1]; res[5] = LAB_TMP[2];
  return res;
}

export function applySkinMatchRGBA(buf, match, mask, ch = 4, people = null, original = null) {
  if (!mask || !match) return buf;
  const p = { skinMatch: match };
  const res = [0, 0, 0, 0, 0, 0], origLab = [0, 0, 0];
  for (let i = 0, j = 0; i < mask.length; i++, j += ch) {
    const personId = people?.[i] ?? 0;
    if (mask[i] === 0 || (match.version === 2 && !personId)) continue;
    res[0] = SRGB8_TO_LIN[buf[j]]; res[1] = SRGB8_TO_LIN[buf[j + 1]]; res[2] = SRGB8_TO_LIN[buf[j + 2]];
    let originalL = null;
    if (original && Number.isFinite(original[j])) {
      linToLab(SRGB8_TO_LIN[original[j]], SRGB8_TO_LIN[original[j + 1]], SRGB8_TO_LIN[original[j + 2]], origLab); originalL = origLab[0];
    }
    applySkinMatchLinear(res, p, mask[i], personId, originalL);
    buf[j] = Math.round(linearToSrgb(clamp(res[0], 0, 1)) * 255); buf[j + 1] = Math.round(linearToSrgb(clamp(res[1], 0, 1)) * 255); buf[j + 2] = Math.round(linearToSrgb(clamp(res[2], 0, 1)) * 255);
  }
  return buf;
}
