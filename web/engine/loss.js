// Information-loss check: what an edit destroys compared with the original.
// Works on a PixelSet (from prepare) and the processed arrays (from processPixelSet).
//
//   blown     – pixels pushed to pure white (a channel at 255 and near-white) that weren't before
//   crushed   – pixels pushed to pure black that weren't before
//   color     – saturated colors pinned at a channel limit (loses texture in reds, skies, neon)
//   flattened – places that had visible texture (L* gradient) and now have almost none
//   banding   – tone curve steep enough to show steps in smooth skies/walls

import { toneMaxSlope as slope1, toneReversal as rev1, hasLocal, regionParams } from './pipeline.js';

// with subject / background amounts, the steepest (or most reversed) of the two regions' curves counts
const toneMaxSlope = (p) => (hasLocal(p) ? Math.max(...Object.values(regionParams(p)).map(slope1)) : slope1(p));
const toneReversal = (p) => (hasLocal(p) ? Math.max(...Object.values(regionParams(p)).map(rev1)) : rev1(p));

const HI = 0.9955, LO = 0.0006; // linear values for 8-bit 254.5 and ~2

// thresholds are percent of the photo (banding: max curve slope)
export const LIMITS = {
  blown: { warn: 0.3, bad: 1.5 },
  crushed: { warn: 0.5, bad: 2 },
  color: { warn: 1, bad: 4 },
  flattened: { warn: 4, bad: 8 },
  banding: { warn: 2.6, bad: 3.4 },
  uneven: { warn: 1.5, bad: 4 },
  reversal: { warn: 0.5, bad: 2 },
  dullSkin: { warn: 1, bad: 1.6 },
};

const LABEL = {
  blown: 'Blown highlights',
  crushed: 'Crushed shadows',
  color: 'Clipped color',
  flattened: 'Lost detail',
  banding: 'Banding risk',
  uneven: 'Blotchy color',
  reversal: 'Reversed tones',
  dullSkin: 'Faces dulled',
};

export function counts(ps, cur, idx) {
  let blown = 0, crushed = 0, color = 0;
  const N = idx ? idx.length : ps.n;
  for (let k = 0; k < N; k++) {
    const i = idx ? idx[k] : k;
    const or = ps.lr[i], og = ps.lg[i], ob = ps.lb[i];
    const nr = cur.lr[i], ng = cur.lg[i], nb = cur.lb[i];
    const omx = Math.max(or, og, ob), omn = Math.min(or, og, ob);
    const nmx = Math.max(nr, ng, nb), nmn = Math.min(nr, ng, nb);
    const nearWhite = cur.L[i] > 90;
    if (nmx >= HI && nearWhite) { if (!(omx >= HI && ps.L[i] > 90)) blown++; }
    else if (nmx <= LO) { if (!(omx <= LO)) crushed++; }
    else if ((nmx >= HI && cur.L[i] > 20) || (nmn <= LO && cur.L[i] > 30)) { if (!(omx >= HI || omn <= LO)) color++; }
  }
  return { blown: (100 * blown) / N, crushed: (100 * crushed) / N, color: (100 * color) / N };
}

function flattened(ps, cur) {
  const W = ps.width, H = ps.height;
  let had = 0, lost = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const go = Math.abs(ps.L[i + 1] - ps.L[i]) + Math.abs(ps.L[i + W] - ps.L[i]);
      if (go < 2.5) continue;
      had++;
      const gn = Math.abs(cur.L[i + 1] - cur.L[i]) + Math.abs(cur.L[i + W] - cur.L[i]);
      if (gn < 0.3 * go) lost++;
    }
  }
  return (100 * lost) / Math.max(1, (W - 1) * (H - 1));
}

// Blotches and steps: where the edit pushes nearly identical neighbors far apart. A smooth global edit
// changes neighbors by similar amounts; a steep curve or clashing HSL bands amplify tiny differences into
// visible edges. Measured as the Lab difference of the edit between neighbors vs the original difference.
// Faces count double, since blotchy skin is what people notice first.
function uneven(ps, cur) {
  const W = ps.width, H = ps.height;
  const skin = ps.masks.skin;
  let bad = 0, tot = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const w = skin[i] ? 2 : 1;
      tot += w;
      for (const j of [i + 1, i + W]) {
        const dOrig = Math.hypot(ps.L[j] - ps.L[i], ps.A[j] - ps.A[i], ps.B[j] - ps.B[i]);
        if (dOrig > 3) continue; // real edges in the photo are not the edit's fault
        const dNew = Math.hypot(cur.L[j] - cur.L[i], cur.A[j] - cur.A[i], cur.B[j] - cur.B[i]);
        if (dNew > 2.5 && dNew > 3 * dOrig + 0.5) { bad += w; break; }
      }
    }
  }
  return (100 * bad) / Math.max(1, tot);
}

// Lit side of faces (or skin-colored areas): how much darker and greyer the edit made it.
// Score 1 = 10 L* darker or 30% less color; the text reports the actual numbers.
function dullSkin(ps, cur) {
  if (ps.skinSource !== 'faces') return { score: 0 }; // without real faces this would judge sand and wood
  let n = 0, L0 = 0, L1 = 0, C0 = 0, C1 = 0;
  for (let i = 0; i < ps.n; i++) {
    if (ps.masks.skin[i] !== 2) continue;
    n++; L0 += ps.L[i]; L1 += cur.L[i];
    C0 += Math.hypot(ps.A[i], ps.B[i]); C1 += Math.hypot(cur.A[i], cur.B[i]);
  }
  if (n < 30) return { score: 0 };
  const drop = (L0 - L1) / n, ratio = C1 / Math.max(1e-6, C0);
  return { score: Math.max(drop / 10, (1 - ratio) / 0.3), drop, ratio };
}

function level(kind, v) {
  const l = LIMITS[kind];
  return v >= l.bad ? 'bad' : v >= l.warn ? 'warn' : 'ok';
}

/** Full report for the preview. params is needed for the banding check. */
export function lossReport(ps, cur, params) {
  const c = counts(ps, cur);
  const ds = dullSkin(ps, cur);
  const vals = { ...c, flattened: flattened(ps, cur), banding: toneMaxSlope(params), uneven: uneven(ps, cur), reversal: toneReversal(params), dullSkin: ds.score };
  const issues = [];
  for (const k of Object.keys(LIMITS)) {
    const lv = level(k, vals[k]);
    if (lv !== 'ok') {
      issues.push({
        kind: k, level: lv, value: vals[k], label: LABEL[k],
        text: k === 'banding' ? `${LABEL[k]}: curve ${vals[k].toFixed(1)}× steep`
          : k === 'reversal' ? `${LABEL[k]}: curve runs backwards (dark halos)`
          : k === 'dullSkin' ? `${LABEL[k]}: ${ds.drop > 1 ? `${Math.round(ds.drop)} L* darker` : ''}${ds.drop > 1 && ds.ratio < 0.95 ? ', ' : ''}${ds.ratio < 0.95 ? `${Math.round((1 - ds.ratio) * 100)}% less color` : ''}`
          : `${LABEL[k]}: ${vals[k] < 1 ? vals[k].toFixed(1) : Math.round(vals[k])}% of the photo`,
      });
    }
  }
  issues.sort((a, b) => (a.level === b.level ? b.value / LIMITS[b.kind].warn - a.value / LIMITS[a.kind].warn : a.level === 'bad' ? -1 : 1));
  return { values: vals, issues, worst: issues[0]?.level || 'ok' };
}

// single number used to rank which sliders cause the damage
function score(c, slope, rev = 0) {
  return c.blown / LIMITS.blown.warn + c.crushed / LIMITS.crushed.warn + c.color / LIMITS.color.warn + Math.max(0, slope - 2.2) * 2 + rev * 2;
}

/**
 * Which sliders are responsible: set each non-zero slider back to 0 (one at a time) and see how much the
 * damage drops. process(params, idx, cur) must run the pipeline on the subset. Returns up to 3 keys.
 */
// Keys are slider keys, or 'subject:<key>' / 'background:<key>' for a region's local amount.
const getK = (p, k) => { const j = k.indexOf(':'); return j < 0 ? p[k] || 0 : (p.local && p.local[k.slice(0, j)] && p.local[k.slice(0, j)][k.slice(j + 1)]) || 0; };
function setK(p, k, v) {
  const j = k.indexOf(':');
  if (j < 0) return { ...p, [k]: v };
  const r = k.slice(0, j);
  return { ...p, local: { ...p.local, [r]: { ...(p.local && p.local[r]), [k.slice(j + 1)]: v } } };
}

export function culprits(ps, params, process, idx, cur, keys, auto = null) {
  const base = score(counts(ps, process(params, idx, cur), idx), toneMaxSlope(params), toneReversal(params));
  if (base < 1) return [];
  // Sliders the user moved away from the auto match are suspects first (revert to the auto value);
  // if the user changed nothing, every non-zero slider is a suspect (revert to 0).
  let suspects = auto ? keys.filter((k) => !k.endsWith('Hue') && Math.abs(getK(params, k) - getK(auto, k)) > 1e-6) : [];
  const revertTo = (k) => (suspects.length ? getK(auto, k) : 0);
  if (!suspects.length) suspects = keys.filter((k) => getK(params, k) && !k.endsWith('Hue'));
  const out = [];
  for (const k of suspects) {
    const q = setK(params, k, revertTo(k));
    const s = score(counts(ps, process(q, idx, cur), idx), toneMaxSlope(q), toneReversal(q));
    out.push({ key: k, value: getK(params, k), gain: base - s });
  }
  out.sort((a, b) => b.gain - a.gain);
  const strong = out.filter((c) => c.gain > 0.2 * base);
  // sliders that push the same way can mask each other (exposure and whites both blowing the sky),
  // so when no single one is decisive, name the top two that help at all
  return (strong.length ? strong : out.filter((c) => c.gain > 0.05 * base)).slice(0, 3);
}
