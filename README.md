# LookMatch

Copies the look of a reference photo onto other photos. A preset stores the reference's **measured targets**
(tone percentiles, curve shape, neutral cast, zone color, HSL bands, saturation), not slider values.
Every incoming photo is measured and solved on its own.

## Layout
- `engine/` — shared by the browser and Node
  - `measure.js` — stats for any image (preview-size); fixed pixel masks so edited images compare like with like
  - `pipeline.js` — Lightroom-style sliders as deterministic global ops, compiled to a 33³ LUT
  - `solver.js` — staged bounded Levenberg–Marquardt: tone → white balance → color → touch-up, with clipping, banding and skin guards
  - `transfer.js` — color transfer (histogram match + Monge-Kantorovich), baked to a LUT. Test-only for now: lost to the solver on every look in tools/compare.mjs
  - `xmp.js`, `jpegmeta.js` — Lightroom settings (embedded XMP and .xmp preset), EXIF carry-over
- `web/` — the iPhone web app (static files; `npm run build` copies the engine in)
- `tools/` — `measure.mjs` (print stats), `match.mjs` (before/after table), `e2e.mjs` (headless browser test)

## Checks built in
- Face outlines (MediaPipe Face Landmarker, in the worker) drive the skin guard; skin-colored areas are the fallback.
- Camera settings (exifr) give scene EV, so dark scenes stay dark and underexposed daylight may brighten.
- `engine/loss.js`: blown, crushed, clipped color, lost detail, banding, reversed tones, blotchy color, dulled faces — with slider blame.

## Test scripts
```
npm i
node tools/measure.mjs photo.jpg
node tools/match.mjs ref.jpg a.jpg b.jpg --out out [--strength 0.8] [--full]
tools/with-server.sh node tools/faces.mjs testdata/in/*   # cache face outlines for match.mjs
tools/flip_all.sh out                                     # NVIDIA FLIP: faces vs scene change (pip install flip-evaluator)
node tools/artifacts.mjs ref.jpg photo.jpg                # good vs deliberately bad edits through the loss checks
tools/with-server.sh node tools/e2e.mjs scratch/e2e       # headless browser test of the app
node tools/compare.mjs testdata/kodak --similar --out scratch/cmp   # ground-truth test: solver vs color transfer
python3 tools/compare_score.py scratch/cmp                          # CIEDE2000 vs the right answer (pip install color-matcher scikit-image)
python3 tools/run_models.py scratch/cmp --np-repo ../Neural-Preset --np-ckpt W/np_ckpt --dp-repo ../deep_preset --dp-ckpt W/dp_wppl.pth.tar  # outside models (PyTorch, CPU)
python3 tools/fit_color_map.py scratch/cmp deeppreset && node tools/loss_png.mjs scratch/cmp neuralpreset deeppreset deeppreset-map
```
