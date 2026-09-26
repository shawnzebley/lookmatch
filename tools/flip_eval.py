#!/usr/bin/env python3
"""FLIP (NVIDIA, BSD-3) perceptual difference between an original and edited photo.
Reports mean FLIP over the whole frame and inside detected faces. An edit that copies a look should change
the scene more than the faces; a face ratio well above 1 means skin took the hit (dulled, greyed, recolored).
Usage: flip_eval.py orig.png edited.png [faces.json] [heatmap_out.png]"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
import flip_evaluator as flip

def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float32) / 255.0

orig, edit = load(sys.argv[1]), load(sys.argv[2])
faces = json.load(open(sys.argv[3])) if len(sys.argv) > 3 and sys.argv[3] != '-' else []
fmap, mean, _ = flip.evaluate(orig, edit, 'LDR', applyMagma=False)
fmap = np.squeeze(fmap)
if fmap.ndim == 3: fmap = fmap[..., 0]
h, w = fmap.shape
mask = Image.new('L', (w, h), 0)
d = ImageDraw.Draw(mask)
for poly in faces:
    d.polygon([(x * w, y * h) for x, y in poly], fill=255)
m = np.asarray(mask) > 0
face = float(fmap[m].mean()) if m.any() else None
rest = float(fmap[~m].mean())
out = {'flip_mean': round(float(mean), 4), 'flip_faces': None if face is None else round(face, 4), 'flip_rest': round(rest, 4),
       'face_ratio': None if face is None else round(face / max(rest, 1e-6), 2)}
print(json.dumps(out))
if len(sys.argv) > 4:
    heat = (np.clip(fmap / 0.5, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(heat).convert('RGB').save(sys.argv[4])
