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

OPEN
- Not yet tested on Shawn's actual iPhone: speed of 50 × 24 MP batch, createImageBitmap on 24 MP in Safari, share-sheet save flow, Drive sign-in round trip (Google accepts the redirect; full login not exercised).
- Unknown whether OAuth consent screen has shawnzebley@gmail.com as test user and Drive API enabled (Shawn said he'd do it; not verified).
- Known misses on the 11-photo test: t06 zone color 10.6, t08 tone 3.7, t02 zone 4.0, t10 skin hue already 65° pre-edit.
- iPhone photos are Display P3; canvas converts to sRGB, so wide-gamut colors get clamped. Not addressed.
- Skin detection is a color window, not face detection (MediaPipe skipped).
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
- 2026-09-26: engine + app built, 11-photo test run, deployed to GitHub Pages, OAuth redirect fixed.
