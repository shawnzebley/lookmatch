# Measure a folder of a photographer's published images (the numbers behind engine/finish.js profiles).
# usage: python3 tools/measure_published.py <folder>  -> JSON summary (medians across images)
import sys, json, io, hashlib, numpy as np
from PIL import Image
def lab(rgb):
    c = rgb / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)
def one(im):
    im = im.convert('RGB'); s = min(1, 500 / max(im.size)); im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.BILINEAR)
    a = np.asarray(im).astype(np.float64); H, W = a.shape[:2]
    if W < 150 or H < 150: return None
    L = lab(a); Lc, A, B = L[..., 0], L[..., 1], L[..., 2]; C = np.hypot(A, B)
    r = {'p1': np.percentile(Lc, 1), 'p50': np.percentile(Lc, 50), 'p99': np.percentile(Lc, 99), 'C': C.mean(), 'bw': bool(C.mean() < 3)}
    n = Lc.size
    for name, m in (('sh', Lc < 30), ('mid', (Lc >= 30) & (Lc < 70)), ('hi', Lc >= 70)):
        r[name] = [A[m].mean(), B[m].mean()] if m.sum() > n * 0.03 else None
    yy, xx = np.mgrid[0:H, 0:W]; rr = np.hypot(xx / W - .5, yy / H - .5)
    r['vig'] = Lc[rr < .2].mean() - Lc[rr > .6].mean()
    g = a[..., 1]; lap = np.abs(4 * g[1:-1, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:] - g[:-2, 1:-1] - g[2:, 1:-1]); r['lap'] = lap.mean()
    # skin-ish pixels (warm hue, mid L): their mean a/b and L tell how skin is rendered
    h = np.degrees(np.arctan2(B, A)); sk = (h > 25) & (h < 70) & (C > 8) & (C < 45) & (Lc > 30) & (Lc < 85)
    r['skin'] = [Lc[sk].mean(), A[sk].mean(), B[sk].mean()] if sk.sum() > n * 0.03 else None
    return r
def med(v):
    v = [x for x in v if x is not None]
    return round(float(np.median(v)), 1) if v else None
def summarize(R):
    col = [r for r in R if not r['bw']]
    return {'n': len(R), 'bw': len(R) - len(col), 'p1': med([r['p1'] for r in R]), 'p1_over8': int(sum(r['p1'] > 8 for r in R)), 'p50': med([r['p50'] for r in R]),
            'p99': med([r['p99'] for r in R]), 'p99_under90': int(sum(r['p99'] < 90 for r in R)), 'chroma': med([r['C'] for r in col]),
            'sh': [med([r['sh'] and r['sh'][0] for r in col]), med([r['sh'] and r['sh'][1] for r in col])],
            'mid': [med([r['mid'] and r['mid'][0] for r in col]), med([r['mid'] and r['mid'][1] for r in col])],
            'hi': [med([r['hi'] and r['hi'][0] for r in col]), med([r['hi'] and r['hi'][1] for r in col])],
            'skin': [med([r['skin'] and r['skin'][i] for r in col]) for i in range(3)],
            'vig': med([r['vig'] for r in R]), 'lap': med([r['lap'] for r in R])}
if __name__ == '__main__':
    import glob, os
    files = sorted(glob.glob(sys.argv[1] + '/*'))
    R, seen = [], set()
    for f in files:
        try:
            im = Image.open(f); t = im.convert('L').resize((8, 8)); k = tuple((np.asarray(t) // 16).flatten())
            if k in seen: continue
            seen.add(k); r = one(im)
            if r: R.append(r)
        except Exception as e: pass
    print(json.dumps(summarize(R)))
