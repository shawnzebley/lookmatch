#!/usr/bin/env python3
"""Scores tools/compare.mjs output: CIEDE2000 between each method's result and the ground truth L(T).
Also runs the reference Python color-matcher (hm-mvgd-hm) on the same inputs as an outside check.
Usage: python3 tools/compare_score.py scratch/compare [--no-py]"""
import json, sys, os
import numpy as np
from PIL import Image
from skimage.color import rgb2lab, deltaE_ciede2000

d = sys.argv[1]
use_py = '--no-py' not in sys.argv
runs = json.load(open(os.path.join(d, 'runs.json')))
methods = ['orig'] + runs['methods'] + (['py:hm-mvgd-hm'] if use_py else [])
if use_py:
    from color_matcher import ColorMatcher

def im(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float64) / 255

out = []
for r in runs['rows']:
    base = os.path.join(d, r['id'])
    gt = rgb2lab(im(base + '__gt.png'))
    scores = {}
    for m in methods:
        if m == 'py:hm-mvgd-hm':
            res = ColorMatcher().transfer(src=im(base + '__orig.png') * 255, ref=im(base + '__ref.png') * 255, method='hm-mvgd-hm')
            x = np.clip(res, 0, 255) / 255
        else:
            x = im(base + ('__orig.png' if m == 'orig' else f'__{m}.png'))
        de = deltaE_ciede2000(rgb2lab(x), gt)
        scores[m] = {'mean': float(de.mean()), 'p95': float(np.percentile(de, 95))}
    r['dE'] = scores
    out.append(r)
    print('.', end='', flush=True)
print()
json.dump({'methods': methods, 'rows': out}, open(os.path.join(d, 'scored.json'), 'w'), indent=1)

looks = sorted(set(r['look'] for r in out), key=[r['look'] for r in out].index)
print('mean dE00 vs ground truth (lower is better; under ~2 is hard to see, over ~5 is obvious)')
print('look'.ljust(15) + ''.join(m.rjust(15) for m in methods))
for lk in looks + ['ALL']:
    rs = [r for r in out if lk == 'ALL' or r['look'] == lk]
    print(lk.ljust(15) + ''.join(f"{np.mean([r['dE'][m]['mean'] for r in rs]):15.2f}" for m in methods))
print('\nwins (lowest mean dE per case):')
for m in methods[1:]:
    print(f"  {m}: {sum(1 for r in out if min(methods[1:], key=lambda k: r['dE'][k]['mean']) == m)}")
