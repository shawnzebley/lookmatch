// Information-loss check: what an edit destroys compared with the original.
// Works on a PixelSet (from prepare) and the processed arrays (from processPixelSet).
//
//   blown     – pixels pushed to pure white (a channel at 255 and near-white) that weren't before
//   crushed   – pixels pushed to pure black that weren't before
//   color     – saturated colors pinned at a channel limit (loses texture in reds, skies, neon)
//   flattened – places that had visible texture (L* gradient) and now have almost none
//   banding   – tone curve steep enough to show steps in smooth skies/walls

import { toneMaxSlope } from './pipeline.js';

const HI = 0.9955, LO = 0.0006; // linear values for 8-bit 254.5 and ~2

// thresholds are percent of the photo (banding: max curve slope)
export const LIMITS = {
  blown: { warn: 0.3, bad: 1.5 },
  crushed: { warn: 0.5, bad: 2 },
  color: { warn: 1, bad: 4 },
  flattened: { warn: 2, bad: 6 },
  banding: { warn: 2.6, bad: 3.4 },
};

const LABEL = {
  blown: 'Blown highlights',
  crushed: 'Crushed shadows',
  color: 'Clipped color',
  flattened: 'Lost detail',
  banding: 'Banding risk',
};

function counts(ps, cur, idx) {
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
    else if (nmx >= HI || nmn <= LO) { if (!(omx >= HI || omn <= LO)) color++; }
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

function level(kind, v) {
  const l = LIMITS[kind];
  return v >= l.bad ? 'bad' : v >= l.warn ? 'warn' : 'ok';
}

/** Full report for the preview. params is needed for the banding check. */
export function lossReport(ps, cur, params) {
  const c = counts(ps, cur);
  const vals = { ...c, flattened: flattened(ps, cur), banding: toneMaxSlope(params) };
  const issues = [];
  for (const k of Object.keys(LIMITS)) {
    const lv = level(k, vals[k]);
    if (lv !== 'ok') {
      issues.push({
        kind: k, level: lv, value: vals[k], label: LABEL[k],
        text: k === 'banding' ? `${LABEL[k]}: curve ${vals[k].toFixed(1)}× steep` : `${LABEL[k]}: ${vals[k] < 1 ? vals[k].toFixed(1) : Math.round(vals[k])}% of the photo`,
      });
    }
  }
  issues.sort((a, b) => (a.level === b.level ? b.value / LIMITS[b.kind].warn - a.value / LIMITS[a.kind].warn : a.level === 'bad' ? -1 : 1));
  return { values: vals, issues, worst: issues[0]?.level || 'ok' };
}

// single number used to rank which sliders cause the damage
function score(c, slope) {
  return c.blown / LIMITS.blown.warn + c.crushed / LIMITS.crushed.warn + c.color / LIMITS.color.warn + Math.max(0, slope - 2.2) * 2;
}

/**
 * Which sliders are responsible: set each non-zero slider back to 0 (one at a time) and see how much the
 * damage drops. process(params, idx, cur) must run the pipeline on the subset. Returns up to 3 keys.
 */
export function culprits(ps, params, process, idx, cur, keys, auto = null) {
  const base = score(counts(ps, process(params, idx, cur), idx), toneMaxSlope(params));
  if (base < 1) return [];
  // Sliders the user moved away from the auto match are suspects first (revert to the auto value);
  // if the user changed nothing, every non-zero slider is a suspect (revert to 0).
  let suspects = auto ? keys.filter((k) => !k.endsWith('Hue') && Math.abs((params[k] || 0) - (auto[k] || 0)) > 1e-6) : [];
  const revertTo = (k) => (suspects.length ? auto[k] || 0 : 0);
  if (!suspects.length) suspects = keys.filter((k) => params[k] && !k.endsWith('Hue'));
  const out = [];
  for (const k of suspects) {
    const q = { ...params, [k]: revertTo(k) };
    const s = score(counts(ps, process(q, idx, cur), idx), toneMaxSlope(q));
    out.push({ key: k, value: params[k], gain: base - s });
  }
  out.sort((a, b) => b.gain - a.gain);
  const strong = out.filter((c) => c.gain > 0.2 * base);
  // sliders that push the same way can mask each other (exposure and whites both blowing the sky),
  // so when no single one is decisive, name the top two that help at all
  return (strong.length ? strong : out.filter((c) => c.gain > 0.05 * base)).slice(0, 3);
}
