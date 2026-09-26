#!/usr/bin/env python3
"""For a model that redraws the whole photo (Deep Preset), keep only its color change: fit a smooth
3rd-order polynomial color map orig -> model output on the preview, then apply that map to the original.
This is how a model result would reach full resolution without its blur. Writes <case>__<m>-map.png.
Usage: python3 tools/fit_color_map.py scratch/cmp deeppreset"""
import json, os, sys
import numpy as np
from PIL import Image
d, m = sys.argv[1], sys.argv[2]
runs = json.load(open(os.path.join(d, 'runs.json')))
im = lambda p: np.asarray(Image.open(p).convert('RGB')).astype(np.float64) / 255
def feats(x):
    r, g, b = x[:, 0], x[:, 1], x[:, 2]
    cols = [np.ones_like(r)]
    for i in range(4):
        for j in range(4 - i):
            for k in range(4 - i - j):
                if i + j + k: cols.append(r**i * g**j * b**k)
    return np.stack(cols, 1)
for r in runs['rows']:
    base = os.path.join(d, r['id'])
    o, y = im(base + '__orig.png'), im(base + f'__{m}.png')
    X, Y = feats(o.reshape(-1, 3)), y.reshape(-1, 3)
    lam = 1e-3 * len(X)
    W = np.linalg.solve(X.T @ X + lam * np.eye(X.shape[1]), X.T @ Y)
    out = np.clip(X @ W, 0, 1).reshape(o.shape)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(base + f'__{m}-map.png')
    r['methods'][m + '-map'] = dict(r['methods'].get(m, {}))
runs['methods'] = [x for x in runs['methods'] if x != m + '-map'] + [m + '-map']
json.dump(runs, open(os.path.join(d, 'runs.json'), 'w'), indent=1)
print('fitted', len(runs['rows']))
