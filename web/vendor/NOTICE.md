# Third-party code shipped with LookMatch

| Component | Files | License |
|---|---|---|
| MediaPipe Tasks Vision (Google) | vendor/mediapipe/, models/face_landmarker.task | Apache-2.0 |
| exifr (Mike Kovařík) | vendor/exifr-lite.mjs | MIT (vendor/exifr-LICENSE) |
| jpeg-js (Eugene Ware et al.) | vendor/jpeg-encoder.js | BSD-3-Clause (vendor/jpeg-js-LICENSE) |
| libheif-js 1.23 (libheif + libde265, Emscripten build) | vendor/libheif/libheif-bundle.mjs, loaded only when a HEIF/HIF file won't decode natively | LGPL-3.0 (vendor/libheif/LICENSE); unmodified, separate file |

Test-only tools (not shipped): NVIDIA FLIP (`pip install flip-evaluator`, BSD-3-Clause).
