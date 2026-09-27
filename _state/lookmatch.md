# LookMatch checkpoint

OBJECTIVE — iPhone web app that copies a reference photo's look onto other photos by measuring each photo and solving slider values per photo; Shawn can create presets, batch-match, tweak, and export JPEG + Lightroom files to Google Drive from his iPhone 15 Pro Max (iOS 26.6.1).

DECIDED
- No Mac → static web app (Safari / home screen), not native. Engine is plain JS shared by browser workers and Node test tools.
- Repo: github.com/shawnzebley/lookmatch (renamed from "Lookmatch" to lowercase). Site served by GitHub Pages from branch `gh-pages` (= `web/` folder via `git subtree split --prefix web -b gh-pages`, force-pushed). Live URL: https://shawnzebley.github.io/lookmatch/
- Google OAuth client ID (baked in as default in web/app.js): 243038152226-jfgss8uq68lb72bi9j5jqgkdlg475kj8.apps.googleusercontent.com, project project-b4125537-0627-4305-b6c. Registered JS origin https://shawnzebley.github.io ; redirect URI https://shawnzebley.github.io/lookmatch (no trailing slash — app sends it that way on purpose; Pages 301s to /lookmatch/ and keeps the #access_token).
- Drive auth: OAuth implicit token redirect flow, scope drive.file, token lasts 1 hour, sign-in reloads the page. Exports go to Drive › LookMatch › "<preset> <date>"; preset backups to Drive › LookMatch › presets.
- Presets store measured stats + thumbnail, never slider values. Solver: staged bounded Levenberg–Marquardt (tone → WB → color → touch-up) on a 512 px preview; full-res applied via 33³ LUT, tiled (≤4 MP tiles) for iOS canvas limit; JPEG encode with jpeg-js (1.5 s at 24 MP in Node vs 4 s mozjpeg).
- Guards: clipping cap = max(orig, ref) + 0.1%, near-white crowding penalty, curve slope ≤ 2.2, skin hue window 35–64° (Lab) and ±6° drift, lit-skin chroma ≥ 0.75×, adjacent-HSL-band smoothness (6× on red/orange/yellow), sat/vib opposite-sign penalty, final scale-back guard.
- Brightness pull 0.5 toward ref median, reduced for low-key photos (night stays dark).
- Lightroom export: `_lightroom.jpg` = original + embedded crs XMP; `_lookmatch.xmp` = develop preset; modes "sliders" (default) or "curve".
- RAW: later.
- Editor: photo + view toggles + loss bar pinned at top (40vh stage), sliders scroll under it; hold on photo in After mode shows Before.
- Loss check (engine/loss.js): blown ≥0.3% warn / ≥1.5% bad, crushed 0.5/2, clipped color 1/4, lost detail (flattened L* gradient) 2/6, banding curve slope 2.6/3.4. Culprits = sliders changed from the auto match, reverted one at a time. Clipping overlay: red blown, blue crushed, amber clipped color, dim = already in original; turns on automatically the first time an edit goes 'bad'.

OPEN
- Not yet tested on Shawn's actual iPhone: speed of 50 × 24 MP batch, createImageBitmap on 24 MP in Safari, share-sheet save flow, Drive sign-in round trip (Google accepts the redirect; full login not exercised).
- Unknown whether OAuth consent screen has shawnzebley@gmail.com as test user and Drive API enabled (Shawn said he'd do it; not verified).
- Known misses (run 2): tone t02 4.1, t07 4.5; zone t02 4.2, t03 4.0, t06 6.6; t10 skin hue 65° pre-edit. Faces missed: t09, t10, t11.
- iPhone photos are Display P3; canvas converts to sRGB, so wide-gamut colors get clamped. Not addressed.
- Later-version items not built: clarity/local contrast, grain, vignette, RAW.

CONSTRAINTS
- Shawn's replies: shawn-voice skill, short, no sugar-coating, no banned AI phrasing.
- Never commit Shawn's photos (testdata/, out/, scratch/ are gitignored) — repo is public.
- Pass lines used in report: tone ≤ 3 L*, neutral cast ≤ 2 Lab, zone ≤ 4 Lab, new clipping ≤ 0.1%, skin hue 35–65 with lit chroma ≥ 0.6×.
- Commit trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

ARTIFACTS
- Repo files: engine/{color,measure,pipeline,solver,xmp,jpegmeta}.js; web/{index.html,app.js,app.css,worker.js,sw.js,lib/drive.js,lib/db.js,vendor/jpeg-encoder.js}; tools/{measure,match,e2e,report,sheet,sliders}.mjs, tools/build-web.sh (copies engine → web/engine; run before deploying).
- Test report artifact (private): https://claude.ai/artifact/6aw9RehXs3MzxrV1q1ULZe
- Test photos are NOT in the repo; a new session needs Shawn to re-attach them (reference = flat-cap man portrait) to rerun tools/match.mjs.

NEXT ACTION — Wait for Shawn's report from his iPhone: open https://shawnzebley.github.io/lookmatch/ in Safari, Settings → Connect Google Drive, create a preset from the reference, add ~10 photos, Match, Export all. Fix whatever breaks (clone the repo, edit engine/ or web/, run `sh tools/build-web.sh`, commit, push main, then `git subtree split --prefix web -b gh-pages && git push -f origin gh-pages`).

OUT OF SCOPE — native iOS app, Mac-only tooling, storing slider values in presets, publishing Shawn's photos anywhere public.

## Log
- 2026-09-26: fixed the solver copying the reference's scene into the edit. Ablation (tools/solver_eval.mjs) showed the tone stage was the biggest leak: it copied the reference's whole histogram shape. Now only the ends of the tone shape are copied (TONE_SHAPE: p1/p99 full, p5/p95 half, p10/p90 0.2, p25/p75 none; median pull unchanged), and zone tints and HSL bands trust half the measured difference (ZONE_MOVE, BAND_MOVE = 0.5). Mean dE00 vs right answer, same-scene: untouched 6.70, old 7.42, new 5.98 (beats untouched 45/72; bad damage flags 10 -> 6). Random pairs: untouched 7.02, old 10.10, new 8.07 (flags 23 -> 4). Still worse than untouched on subtle looks (warm_film 4.7 vs 4.6, teal_orange 4.8 vs 2.7) — a single edited reference can't fully separate grade from scene.
- 2026-09-26: tested outside models on the same 72+72 cases (mean ΔE00 vs right answer, same-scene / random pairs): untouched 6.70/7.02, solver 7.42/10.10, Deep Preset (minhmanho, wPPL, non-commercial) 6.55/6.52 (color-only map 6.70/6.67), Neural Preset (DY112 unofficial, MIT) 8.67/14.75. Deep Preset won 37/72 and 58/72, only 2 bad damage flags, keeps skin right, doesn't break when scenes differ; but over-edits subtle looks. avg(solver, Deep Preset map) = 5.87 same-scene (best seen). Deep Preset is 268M params / 1 GB, ~2.5 s/photo CPU at 512 px: server-only (Cloud Run), then fit color map and apply at full res in the app. Weights are on Google Drive (gdown works from the container).
- 2026-09-26: tried color transfer (engine/transfer.js, HM-MKL-HM from Pitié/Hahne math; matches Python color-matcher within 0.5 ΔE00). Ground-truth test tools/compare.mjs (6 looks × 12 same-scene Kodak pairs): mean ΔE00 vs right answer — untouched 6.7, solver 7.4, hm-mkl-hm 11.1, mkl 9.5; solver won 59/72; transfer blotchy on 52/72. Not wired into the app. Solver itself is worse than untouched on warm_film/teal_orange/bleach_bypass (pulls reference content colors into the edit) — next thing to fix.
- 2026-09-26: MediaPipe face outlines for skin guard (tiled retry for small faces; 8/11 test photos), exifr scene EV drives brightness (dark scenes damped via `lift`), face-brightness guard in tone stage, reversed-curve block, high-ISO shadow-slope cap, HSL ignores near-black/near-grey noise, new app warnings (Faces dulled, Reversed tones, Blotchy color), FLIP harness (tools/flip_eval.py). Run 2: tone 9/11, cast 11/11, zone 8/11, clip 11/11, skin 10/11, no app warnings on any auto edit.
- 2026-09-26: pinned photo while editing; blown/crushed/lost-detail warnings with slider blame and clipping overlay.
- 2026-09-26: engine + app built, 11-photo test run, deployed to GitHub Pages, OAuth redirect fixed.
