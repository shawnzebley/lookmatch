#!/usr/bin/env python3
"""Runs two public learned color-style models on the cases written by tools/compare.mjs, so
tools/compare_score.py can score them next to the solver.

  Neural Preset (unofficial, github.com/DY112/Neural-Preset, MIT):   writes <case>__neuralpreset.png
  Deep Preset (github.com/minhmanho/deep_preset, non-commercial):    writes <case>__deeppreset.png

Usage: python3 tools/run_models.py scratch/cmp --np-repo ../Neural-Preset --np-ckpt W/np_ckpt \
          --dp-repo ../deep_preset --dp-ckpt W/dp_wppl.pth.tar
Models run on CPU. Not part of the app."""
import argparse, json, os, sys, time
import numpy as np
import torch
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('dir')
ap.add_argument('--np-repo'); ap.add_argument('--np-ckpt')
ap.add_argument('--dp-repo'); ap.add_argument('--dp-ckpt')
a = ap.parse_args()
runs = json.load(open(os.path.join(a.dir, 'runs.json')))
torch.set_grad_enabled(False)
timing = {}

def load(p):
    return Image.open(p).convert('RGB')

# ---------------- Neural Preset -----------------------------------------------------------------
if a.np_ckpt:
    sys.path.insert(0, os.path.abspath(a.np_repo))
    from omegaconf import OmegaConf
    from models.neural_styler_v1 import neural_styler
    cfg = OmegaConf.create({'model': {'k': 16, 'style_encoder': 'efficientnet-b0'}})
    net = neural_styler(cfg)
    sd = torch.load(a.np_ckpt, map_location='cpu', weights_only=False)['state_dict']
    net.load_state_dict({k[4:]: v for k, v in sd.items() if k.startswith('net.')})
    net.eval()
    t256 = lambda im: torch.from_numpy(np.asarray(im.resize((256, 256), Image.BILINEAR), dtype=np.float32) / 255).permute(2, 0, 1)[None]
    ts = []
    for r in runs['rows']:
        base = os.path.join(a.dir, r['id'])
        orig, ref = load(base + '__orig.png'), load(base + '__ref.png')
        t0 = time.time()
        r_c, d_c = net.get_r_and_d(t256(orig))
        r_s, d_s = net.get_r_and_d(t256(ref))
        Z = net.transform_p @ d_c @ net.transform_q      # whiten (removes the photo's own color style)
        Y = net.transform_p @ r_s @ net.transform_q      # color (adds the reference's)
        M = (Y @ Z)[0].numpy()
        x = np.asarray(orig, dtype=np.float32) / 255
        out = np.clip(x.reshape(-1, 3) @ M.T, 0, 1).reshape(x.shape)   # same 3x3 map at any resolution
        ts.append(time.time() - t0)
        Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(base + '__neuralpreset.png')
        print('n', end='', flush=True)
    timing['neuralpreset'] = float(np.median(ts))
    sys.path.pop(0)
    for m in [k for k in sys.modules if k == 'models' or k.startswith('models.')]:
        del sys.modules[m]

# ---------------- Deep Preset -------------------------------------------------------------------
if a.dp_ckpt:
    sys.path.insert(0, os.path.abspath(a.dp_repo))
    from networks.network import get_model
    ckpt = torch.load(a.dp_ckpt, map_location='cpu', weights_only=False)
    G = get_model(ckpt['opts'].g_net)(ckpt['opts'])
    G.load_state_dict(ckpt['G'])
    G.eval()
    tt = lambda im: torch.from_numpy(((np.asarray(im, dtype=np.float32) / 255) - 0.5) / 0.5).permute(2, 0, 1)[None]
    ts = []
    for r in runs['rows']:
        base = os.path.join(a.dir, r['id'])
        orig, ref = load(base + '__orig.png'), load(base + '__ref.png')
        W, H = orig.size
        size = (max(16, round(W / 16) * 16), max(16, round(H / 16) * 16))   # model needs multiples of 16
        t0 = time.time()
        out, _, _ = G.stylize(tt(orig.resize(size, Image.BICUBIC)), tt(ref.resize(size, Image.BICUBIC)), False)
        ts.append(time.time() - t0)
        o = ((out[0].clamp(-1, 1) + 1) / 2).permute(1, 2, 0).numpy()
        Image.fromarray((o * 255 + 0.5).astype(np.uint8)).resize((W, H), Image.BICUBIC).save(base + '__deeppreset.png')
        print('d', end='', flush=True)
    timing['deeppreset'] = float(np.median(ts))
print()

runs['methods'] = [m for m in runs['methods'] if m not in ('neuralpreset', 'deeppreset')] + list(timing)
runs['model_seconds_cpu'] = timing
json.dump(runs, open(os.path.join(a.dir, 'runs.json'), 'w'), indent=1)
print('median seconds per photo on CPU:', timing)
