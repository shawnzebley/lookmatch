# LookMatch

Copies the look of a reference photo onto other photos. A preset stores the reference's **measured targets**
(tone percentiles, curve shape, neutral cast, zone color, HSL bands, saturation), not slider values.
Every incoming photo is measured and solved on its own.

When both photos have usable subject/background masks, each region's reference targets are fitted
directly after isolation. Subject and background each have editable
master and RGB curves; the 25th and 75th tone percentiles contribute to the reference match.
Skin has separate masked Lab color and brightness targets at the selected strength, including
shadows and highlights. After fitting, two passes refine tone, white balance and color against
the actual rendered pixels; skin is then fitted and re-rendered up to three times after finishing.
Reference matching uses full editable slider ranges, with no source-skin preservation penalties
or automatic clipping backoff. Numerical validity and output gamut mapping remain necessary.
Reference Auto Adjust follows a fixed sequence: set the palette from the reference, reduce basic tonal
contrast, fit tone and RGB curves for contrast and color separation, then measure the processed photo
to make a bounded exposure and skin white-balance correction. Without a reference, Auto Adjust keeps
its clean-portrait correction. Without usable region masks, matching falls back to whole-photo targets.

## Layout
- `engine/` — shared by the browser and Node
  - `measure.js` — stats for any image (preview-size); fixed pixel masks so edited images compare like with like
  - `masked-reference.js`, `skin-match.js` — independent region fits and masked reference skin color/brightness in measurement, preview and export
  - `pipeline.js` — Lightroom-style sliders as deterministic global ops, compiled to a 33³ LUT
  - `solver.js` — staged Levenberg–Marquardt: tone → white balance → color → touch-up, inside editable slider ranges
  - `reference-refine.js` — rendered-pixel tone/color refinement followed by final skin correction
  - `transfer.js` — color transfer (histogram match + Monge-Kantorovich), baked to a LUT. Test-only for now: lost to the solver on every look in tools/compare.mjs
  - `xmp.js`, `jpegmeta.js` — Lightroom settings (embedded XMP and .xmp preset, crop fields), EXIF carry-over
  - `geom.js` — crop + level: turned-frame crop rectangle, validity, largest-fit rectangle, auto level, Lightroom crop fields
  - `finish.js`, `style.js`, `style-data.js`, `regions.js` — legacy experimental fitting modules; photographer styles are no longer offered by the app
  - `retouch.js` — skin pass on the skin mask (Texture / Clarity / skin tone) and Heal spots (copy a nearby patch, keep the spot's own light at its edge, opacity), preview and tiled export alike
  - `cull.js` — focus score out of 10 (edge steepness on the face), eyes open/closed from face blendshapes, scene signatures and grouping, keeper score
- `web/segment.js`, `web/mp.js` — subject masks in the worker: MediaPipe Selfie Multiclass finds people, Magic Touch picks the object under a tap; guided-filter refined against the photo's edges
- `web/` — the iPhone web app (static files; `npm run build` copies the engine in)
- `tools/` — `measure.mjs` (print stats), `match.mjs` (before/after table), `e2e.mjs` (headless browser test)

## Files it reads
JPEG, PNG, HEIC, and HEIF/HIF (Fujifilm 10-bit). The browser's own decoder goes first; a HEIF it can't read
is decoded with libheif (web/vendor/libheif, loaded only then) and kept as a q97 JPEG for the session.

## Checks built in
- Face and pose segmentation supply correctable skin masks for person-specific fitting and checks.
- Camera settings (exifr) are retained as scene metadata; they do not override reference brightness.
- `engine/loss.js`: blown, crushed, clipped color, lost detail, banding, reversed tones, blotchy color, dulled faces — with slider blame.

## Test scripts
```
npm test                                                   # reference curves, masked regions, skin matching, Auto Adjust
npm i
python3 tools/fetch_published.py cvatik mckinnon xenie borisov   # published portfolios -> scratch/pub (never committed)
python3 tools/style_records.py cvatik=scratch/pub/cvatik ...     # per-image numbers -> engine/style-data.js
tools/with-server.sh node tools/e2e_edit.mjs scratch/e2e_edit     # HEIF upload, photographer finish + wheels, shrink, crop, export
tools/with-server.sh node tools/e2e_retouch.mjs scratch/e2e_retouch portrait.jpg same_scene.jpg other.jpg   # cull dots, skin, heal, point colour, sync, export
tools/with-server.sh node tools/e2e_subject.mjs scratch/e2e_subject ref.jpg photo.jpg cvatik   # people mask, split fit, Subject tab, tap add/undo, export
node tools/measure.mjs photo.jpg
node tools/match.mjs ref.jpg a.jpg b.jpg --out out [--strength 0.8] [--full]
tools/with-server.sh node tools/faces.mjs testdata/in/*   # cache face outlines for match.mjs
tools/flip_all.sh out                                     # NVIDIA FLIP: faces vs scene change (pip install flip-evaluator)
node tools/artifacts.mjs ref.jpg photo.jpg                # good vs deliberately bad edits through the loss checks
tools/with-server.sh node tools/e2e.mjs scratch/e2e       # headless browser test of the app
node tools/compare.mjs testdata/kodak --similar --out scratch/cmp   # ground-truth test: solver vs color transfer
python3 tools/compare_score.py scratch/cmp                          # CIEDE2000 vs the right answer (pip install color-matcher scikit-image)
node tools/solver_eval.mjs testdata/kodak --variants full,old [--random]  # solver-only version of the same test, all JS; variants blank target groups
python3 tools/run_models.py scratch/cmp --np-repo ../Neural-Preset --np-ckpt W/np_ckpt --dp-repo ../deep_preset --dp-ckpt W/dp_wppl.pth.tar  # outside models (PyTorch, CPU)
python3 tools/fit_color_map.py scratch/cmp deeppreset && node tools/loss_png.mjs scratch/cmp neuralpreset deeppreset deeppreset-map
```

Skin matching measures confident visible skin separately for each detected person, with shadow, midtone and lit-skin targets from the reference. One reference person supplies a style to all source people; multiple reference people are paired by image position, not identity. The details table shows the pairing and measured brightness/color. Ambiguous body pixels are excluded; missed poses use facial skin only. Automatic person targets stay with their own photo when settings are synced.

Bundled adaptive looks now fit each photo against the example's finished appearance. They calculate smooth LAB lighting and color mappings for each source, rather than reusing the example's fixed slider recipe. Lighting follows a monotone luminance distribution; supported hue sectors fit the non-skin palette separately. Supported subject and background regions are solved separately. Skin targets use the reference's measured brightness and color, with the Skin match control setting the correction amount. Amount zero restores the original; manual sliders adjust the mapping, and saved recipes retain it.

The bundled targets are measured with the browser's subject/person analysis. Refresh them reproducibly from cached demonstration images using `node tools/refresh-adaptive-targets.mjs http://127.0.0.1:8877` while serving `web/` locally on that port. Missing detected skin, masks, or reference colors remain unavailable instead of being treated as successful matches. Appearance checks report final tone and hue-band errors in both preview and a decoded export sample, alongside the existing skin checks. These tolerances are provisional, and measurement agreement does not guarantee the same perceived lighting or style across different scenes.

Reference acceptance checks are independent of the solver's aggregate score. A reference result is marked checked only when every required measurement passes: per-person/per-zone brightness error at most 4 L*, skin a*/b* distance at most 5 Lab units, new clipped skin pixels at most 0.5% per person, loss of local skin luminance detail at most 5% of supported source-detail neighborhoods, and subject/background separation error at most 4 L*. Targets follow the selected strength from the original toward the reference. These are provisional product tolerances, not perceptual guarantees or published standards.

Checks measure the actual 8-bit preview after skin correction, retouching, and finishing, rather than the solver's float prediction. Export rechecks a 512-pixel-long-side sample decoded from the encoded JPEG; this does not certify every full-resolution pixel. A failed dimension yields “needs review”; missing masks, face correspondence, target statistics, or measurement support yields “unverified.” These checks report problems without limiting the edit or blocking export. Imported Lightroom presets do not receive reference-match certification. Visual review is still required.

The **Needham workflow** button describes the reference Auto Adjust sequence based on Gerard Needham's published written curve guidance. No video transcript or creator-specific preset has been verified or encoded.

## LAB reference matching and TIFF CLI

In Color → Point color, pick a source color and set separate hue, saturation, and lightness ranges with a soft edge. The point's Hue/Saturation/Luminance adjustments affect only source colors inside that range. Selection uses the original image, so prior edits do not change which pixels qualify. Legacy points keep their original behavior until repicked.

Enable **Limit reference matching to this range** to restrict the automatic LAB lighting/palette mapping to that source range. Each reference region needs at least 20 effective matching samples and 1.5% support in its deterministic sample set; strength fades toward full at 3% support. Missing reference samples or insufficient matching color leave the mapping unchanged in that range. Re-add older uploaded references to obtain these measurements; bundled references include them. The range covers matching colors anywhere in the photo and is saved with adjustment recipes. Skin correction, finish effects, and other manual controls remain separate.

Newly measured references use a per-photo LAB distribution mapping: one smooth luminance quantile curve, separate a/b mean and variance transfer, and supported circular hue-sector residuals. Subject and background get separate mappings when both masks have enough support. Local luminance detail is fitted at the analysis resolution; skin is corrected after rendering. Manual sliders adjust this baseline. Auto Adjust runs the Needham workflow over the result; Re-match restores the calculated reference fit.

The browser still renders 8-bit JPEGs. LAB mappings cannot be represented by Lightroom slider sidecars, so those exports are omitted with a visible explanation. Python offers a separate high-precision path:

```powershell
python -m pip install -r tools/requirements-reference-match.txt
python tools/reference_match.py --reference reference.tif --user_photo original.tif --output matched.tif
```

Optional paired `--reference-mask` and `--user-mask` grayscale masks separate foreground/background. `--strength`, `--chroma-strength`, and `--local-contrast-strength` control the fit. TIFF output is 16-bit with an sRGB profile and preserved alpha; JPEG output is 8-bit. Untagged inputs are treated as sRGB. Non-sRGB 16-bit ICC input requires prior color-managed conversion and produces an actionable error rather than being silently downconverted. The CLI does not detect faces or reproduce the browser's person-specific skin correction. Neither implementation can infer the original photographer's camera profile or guarantee an exact look across different scenes.
