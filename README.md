# LookMatch

Copies the look of a reference photo onto other photos. A preset stores the reference's **measured targets**
(tone percentiles, curve shape, neutral cast, zone color, HSL bands, saturation), not slider values.
Every incoming photo is measured and solved on its own.

## Layout
- `engine/` — shared by the browser and Node
  - `measure.js` — stats for any image (preview-size); fixed pixel masks so edited images compare like with like
  - `pipeline.js` — Lightroom-style sliders as deterministic global ops, compiled to a 33³ LUT
  - `solver.js` — staged bounded Levenberg–Marquardt: tone → white balance → color → touch-up, with clipping, banding and skin guards
  - `xmp.js`, `jpegmeta.js` — Lightroom settings (embedded XMP and .xmp preset), EXIF carry-over
- `web/` — the iPhone web app (static files; `npm run build` copies the engine in)
- `tools/` — `measure.mjs` (print stats), `match.mjs` (before/after table), `e2e.mjs` (headless browser test)

## Test scripts
```
npm i
node tools/measure.mjs photo.jpg
node tools/match.mjs ref.jpg a.jpg b.jpg --out out [--strength 0.8] [--full]
```
