// Hard, per-dimension acceptance checks for the final rendered preview. Limits are
// provisional product thresholds, not published color-science standards.
import { regionStats } from './measure.js';
const LIMITS = Object.freeze({
  minPixels: 20, confidentMask: 191,
  skinL: 4, skinChroma: 5, skinNewClippingPct: 0.5, skinDetailLossPct: 5,
  subjectBackgroundSep: 4,
});
const finite = Number.isFinite;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const median = (xs) => {
  if (!xs.length) return NaN;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length & 1 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
};
const dims = (x) => x && ['L', 'a', 'b'].every((k) => finite(x[k])) && x.L >= 0 && x.L <= 100;
const validTargetRegion = (r) => !!r && ['subject', 'background'].every((key) => {
  const part = r[key];
  return part && Number.isInteger(part.n) && part.n >= LIMITS.minPixels && finite(part.L50) && part.L50 >= 0 && part.L50 <= 100;
}) && finite(r.sep) && Math.abs(r.sep - (r.subject.L50 - r.background.L50)) <= 0.1;
const issue = (checks, key, label, status, value, limit, reason) => checks.push({ key, label, status, value, limit, reason });

function skinGroups(ps) {
  const groups = new Map();
  if (!ps?.skinMask || !ps?.skinPeople || !ps?.L || !ps?.A || !ps?.B) return groups;
  const n = ps.n;
  if (![ps.skinMask, ps.skinPeople, ps.L, ps.A, ps.B].every((a) => a.length === n)) return groups;
  for (let i = 0; i < n; i++) {
    const id = ps.skinPeople[i];
    if (!id || ps.skinMask[i] < LIMITS.confidentMask || !finite(ps.L[i]) || !finite(ps.A[i]) || !finite(ps.B[i])) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(i);
  }
  return groups;
}
function groupedTarget(referenceStats, mapping, sourceId) {
  const map = mapping;
  if (Array.isArray(map?.people)) {
    const match = map.people.find((p) => p.id === sourceId && p.referenceId != null);
    if (!match) return null;
    const ref = referenceStats?.people?.find((p) => p.id === match.referenceId);
    return ref ? { person: ref, referenceId: match.referenceId } : null;
  }
  return null;
}

/**
 * Certify final preview measurements against a reference. `ps` supplies fixed
 * source masks and source Lab; `cur` contains Lab measured from rendered 8-bit
 * pixels. `refStats.skinMatch` may be legacy overall skin stats or a v2 target.
 */
export function referenceAcceptance(ps, cur, refStats, { strength = 1, skinMatch = null } = {}) {
  const checks = [], issues = [];
  const move = finite(strength) ? clamp(strength, 0, 1) : NaN;
  const groups = skinGroups(ps), skinMask = ps?.skinMask;
  const validArrays = cur && ps && Number.isInteger(ps.n) && ps.n > 0 &&
    ['L', 'A', 'B', 'lr', 'lg', 'lb'].every((k) => cur[k] && cur[k].length === ps.n) &&
    ['L', 'A', 'B', 'lr', 'lg', 'lb'].every((k) => ps[k] && ps[k].length === ps.n);
  let safetyPassed = true;

  if (!validArrays || !skinMask || !ps?.skinPeople || !finite(move)) {
    safetyPassed = false;
    issue(checks, 'skin-safety-input', 'Skin mask and rendered measurements', 'unverified', null, null, 'Missing or invalid fixed skin mask, person labels, source Lab, rendered Lab, or strength.');
  } else if (!groups.size) {
    safetyPassed = false;
    issue(checks, 'skin-safety-support', 'Confident skin support', 'unverified', 0, `>=${LIMITS.minPixels} pixels per person`, 'No confidently masked skin person has usable source measurements.');
  } else {
    for (const [id, indices] of groups) {
      const prefix = `person:${id}`;
      if (indices.length < LIMITS.minPixels) {
        safetyPassed = false;
        issue(checks, `${prefix}:support`, `Person ${id} confident skin support`, 'unverified', indices.length, `>=${LIMITS.minPixels} pixels`, 'Insufficient confident pixels to certify safety.');
        continue;
      }
      const newClips = [], detailLoss = [];
      let invalidSafetyMeasurement = false;
      for (const i of indices) {
        const sourceLab = ['L', 'A', 'B'].map((k) => ps[k][i]);
        const renderedLab = ['L', 'A', 'B'].map((k) => cur[k][i]);
        const sr = ['lr', 'lg', 'lb'].map((k) => ps[k][i]), dr = ['lr', 'lg', 'lb'].map((k) => cur[k][i]);
        if (![...sourceLab, ...renderedLab, ...sr, ...dr].every(finite)) {
          invalidSafetyMeasurement = true;
        } else {
          // An already-clipped channel must not hide newly clipped other channels.
          newClips.push(dr.some((v, channel) =>
            (v <= 0.0006 && sr[channel] > 0.0006) || (v >= 0.9955 && sr[channel] < 0.9955)));
        }
        if (finite(ps.L[i]) && finite(cur.L[i])) {
          // Detect lost local luminance detail in a 3x3 neighborhood, requiring
          // a source range >=3 L*. Only such qualifying neighborhoods enter denominator.
          const x = i % (ps.width || 0), y = Math.floor(i / (ps.width || 1));
          const sw = ps.width;
          if (sw > 0 && ps.height > 0 && x > 0 && x + 1 < sw && y > 0 && y + 1 < ps.height) {
            const src = [], dst = [];
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const j = (y + dy) * sw + x + dx;
              if (j < skinMask.length && skinMask[j] >= LIMITS.confidentMask && ps.skinPeople[j] === id) {
                if (!finite(ps.L[j]) || !finite(cur.L[j])) invalidSafetyMeasurement = true;
                else { src.push(ps.L[j]); dst.push(cur.L[j]); }
              }
            }
            if (src.length >= 5) {
              const sRange = Math.max(...src) - Math.min(...src), dRange = Math.max(...dst) - Math.min(...dst);
              if (sRange >= 3) detailLoss.push(dRange < sRange * 0.3);
            }
          }
        }
      }
      if (!newClips.length || invalidSafetyMeasurement) {
        safetyPassed = false;
        issue(checks, `${prefix}:new-clipping`, `Person ${id} new skin clipping`, 'unverified', newClips.length, `Finite RGB for all >=${LIMITS.confidentMask} mask pixels`, 'Missing or non-finite source/rendered measurements prevent clipping certification.');
      } else {
        const clipPct = 100 * newClips.filter(Boolean).length / newClips.length;
        const clipOk = clipPct <= LIMITS.skinNewClippingPct;
        safetyPassed &&= clipOk;
        issue(checks, `${prefix}:new-clipping`, `Person ${id} new skin clipping`, clipOk ? 'pass' : 'fail', clipPct, `<=${LIMITS.skinNewClippingPct}%`, clipOk ? `New clipping ${clipPct.toFixed(2)}% is within limit ${LIMITS.skinNewClippingPct}%.` : `New clipping ${clipPct.toFixed(2)}% exceeds limit ${LIMITS.skinNewClippingPct}%.`);
      }
      if (detailLoss.length && !invalidSafetyMeasurement) {
        const detailPct = 100 * detailLoss.filter(Boolean).length / detailLoss.length;
        const detailOk = detailPct <= LIMITS.skinDetailLossPct;
        safetyPassed &&= detailOk;
        issue(checks, `${prefix}:detail-loss`, `Person ${id} lost skin luminance detail`, detailOk ? 'pass' : 'fail', detailPct, `<=${LIMITS.skinDetailLossPct}% of qualifying source-detail neighborhoods`, detailOk ? `Detail loss ${detailPct.toFixed(2)}% is within limit ${LIMITS.skinDetailLossPct}%.` : `Detail loss ${detailPct.toFixed(2)}% exceeds limit ${LIMITS.skinDetailLossPct}%.`);
      } else {
        safetyPassed = false;
        issue(checks, `${prefix}:detail-loss`, `Person ${id} lost skin luminance detail`, 'unverified', detailLoss.length, 'At least one qualifying source-detail neighborhood', invalidSafetyMeasurement ? 'Missing or non-finite neighborhood measurements prevent detail certification.' : 'No qualifying source-detail neighborhoods with at least 3 L* source range are available.');
      }
    }
  }

  const targetStats = refStats?.skinMatch;
  if (validArrays && groups.size && finite(move)) {
    const grouped = Array.isArray(targetStats?.people);
    if (grouped) {
      for (const [id, indices] of groups) {
        const pair = groupedTarget(targetStats, skinMatch, id);
        if (!pair || indices.length < LIMITS.minPixels) {
          issue(checks, `person:${id}:target`, `Person ${id} reference correspondence`, 'unverified', pair?.referenceId ?? null, 'Explicit valid mapping', 'Missing matched reference person or insufficient confident source support.');
          continue;
        }
        const refPerson = pair.person;
        const sourceL = indices.map((i) => ps.L[i]);
        const q33 = quantile(sourceL, 1 / 3), q67 = quantile(sourceL, 2 / 3);
        const zoneNames = q33 === q67 ? ['midtone'] : ['shadow', 'midtone', 'lit'];
        for (const zone of zoneNames) {
          const zoneIdx = indices.filter((i) => q33 === q67 ? zone === 'midtone' : zone === 'shadow' ? ps.L[i] <= q33 : zone === 'lit' ? ps.L[i] > q67 : ps.L[i] > q33 && ps.L[i] <= q67);
          const ref = refPerson.zones?.[zone];
          const measured = summarizeCur(cur, zoneIdx);
          const key = `person:${id}:${zone}`;
          if (!ref || !dims(ref) || !finite(ref.pixels) || ref.pixels < LIMITS.minPixels || !measured || !dims(measured)) {
            issue(checks, key, `Person ${id} ${zone} skin match`, 'unverified', measured, null, 'Missing or invalid expected target zone, rendered Lab, or minimum support.');
            continue;
          }
          const original = summarizeSource(ps, zoneIdx);
          const goal = { L: original.L + (ref.L - original.L) * move, a: original.a + (ref.a - original.a) * move, b: original.b + (ref.b - original.b) * move };
          addSkinChecks(checks, key, `Person ${id} ${zone}`, measured, goal);
        }
      }
    } else if (dims(targetStats) && finite(targetStats.pixels) && targetStats.pixels >= LIMITS.minPixels) {
      for (const [id, indices] of groups) {
        const measured = summarizeCur(cur, indices), original = summarizeSource(ps, indices);
        if (measured && original) {
          const goal = { L: original.L + (targetStats.L - original.L) * move, a: original.a + (targetStats.a - original.a) * move, b: original.b + (targetStats.b - original.b) * move };
          addSkinChecks(checks, `person:${id}:legacy`, `Person ${id} against overall reference`, measured, goal);
        } else issue(checks, `person:${id}:legacy`, `Person ${id} skin match`, 'unverified', null, null, 'Insufficient finite confident skin measurements.');
      }
    } else {
      issue(checks, 'skin:target', 'Skin reference target', 'unverified', null, null, 'Missing or invalid skin target statistics.');
    }
  }

  // Use the same threshold and median-L* statistic as engine/measure.regionStats.
  const targetRegion = refStats?.regions;
  const sourceRegion = validArrays && ps.subject ? regionStats(ps, ps, null, { details: false }) : null;
  const renderedRegion = validArrays && ps.subject ? regionStats(ps, cur, null, { details: false }) : null;
  if (validArrays && ps.subject && validTargetRegion(targetRegion) && finite(sourceRegion?.sep) && finite(move) && sourceRegion.subject.n >= LIMITS.minPixels && sourceRegion.background.n >= LIMITS.minPixels && renderedRegion.subject.n >= LIMITS.minPixels && renderedRegion.background.n >= LIMITS.minPixels && finite(renderedRegion.sep)) {
      const goal = sourceRegion.sep + (targetRegion.sep - sourceRegion.sep) * move;
      const actual = renderedRegion.sep;
      const error = Math.abs(actual - goal), ok = error <= LIMITS.subjectBackgroundSep;
      issue(checks, 'subject-background-separation', 'Subject/background luminance separation', ok ? 'pass' : 'fail', error, `<=${LIMITS.subjectBackgroundSep} L* error`, ok ? `Rendered separation error ${error.toFixed(2)} L* is within limit ${LIMITS.subjectBackgroundSep} L*.` : `Rendered separation error ${error.toFixed(2)} L* exceeds limit ${LIMITS.subjectBackgroundSep} L*.`);
  } else {
    issue(checks, 'subject-background-separation', 'Subject/background luminance separation', 'unverified', null, `<=${LIMITS.subjectBackgroundSep} L* error`, 'Missing masks, valid region statistics, or minimum source/rendered region support.');
  }

  for (const c of checks) if (c.status === 'fail') issues.push(c.reason);
  const status = checks.some((c) => c.status === 'fail') ? 'rejected' : checks.some((c) => c.status === 'unverified') ? 'unverified' : 'accepted';
  return { status, accepted: status === 'accepted', safetyPassed, checks, issues, limits: LIMITS, scope: 'rendered-preview' };
}

function quantile(values, p) { const a = values.slice().sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]; }
function summarizeCur(cur, indices) { return summarizeArrays(indices.map((i) => ({ L: cur.L[i], a: cur.A[i], b: cur.B[i] }))); }
function summarizeSource(ps, indices) { return summarizeArrays(indices.map((i) => ({ L: ps.L[i], a: ps.A[i], b: ps.B[i] }))); }
function summarizeArrays(values) {
  if (values.length < LIMITS.minPixels || values.some((v) => !dims(v))) return null;
  return { L: median(values.map((v) => v.L)), a: median(values.map((v) => v.a)), b: median(values.map((v) => v.b)), pixels: values.length };
}
function addSkinChecks(checks, key, label, actual, target) {
  const lError = Math.abs(actual.L - target.L), chromaError = Math.hypot(actual.a - target.a, actual.b - target.b);
  const lok = lError <= LIMITS.skinL, cok = chromaError <= LIMITS.skinChroma;
  issue(checks, `${key}:L`, `${label} skin brightness`, lok ? 'pass' : 'fail', lError, `<=${LIMITS.skinL} L*`, `${label}: measured L* ${actual.L.toFixed(2)}, target L* ${target.L.toFixed(2)}, error ${lError.toFixed(2)} L* (limit ${LIMITS.skinL} L*).`);
  issue(checks, `${key}:chroma`, `${label} skin chroma`, cok ? 'pass' : 'fail', chromaError, `<=${LIMITS.skinChroma} Lab`, `${label}: measured a*/b* (${actual.a.toFixed(2)}, ${actual.b.toFixed(2)}), target (${target.a.toFixed(2)}, ${target.b.toFixed(2)}), distance ${chromaError.toFixed(2)} Lab (limit ${LIMITS.skinChroma} Lab).`);
}
