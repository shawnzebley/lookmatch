# Third-party code shipped with LookMatch

| Component | Files | License |
|---|---|---|
| MediaPipe Tasks Vision (Google) | vendor/mediapipe/, models/face_landmarker.task, models/pose_landmarker_lite.task, models/selfie_multiclass_256x256.tflite (people), models/magic_touch.tflite (tap to pick) | Apache-2.0 |
| exifr (Mike Kovařík) | vendor/exifr-lite.mjs | MIT (vendor/exifr-LICENSE) |
| jpeg-js (Eugene Ware et al.) | vendor/jpeg-encoder.js | BSD-3-Clause (vendor/jpeg-js-LICENSE) |
| libheif-js 1.23 (libheif + libde265, Emscripten build) | vendor/libheif/libheif-bundle.mjs, loaded only when a HEIF/HIF file won't decode natively | LGPL-3.0 (vendor/libheif/LICENSE); unmodified, separate file |

Test-only tools (not shipped): NVIDIA FLIP (`pip install flip-evaluator`, BSD-3-Clause).

Pose model: Google MediaPipe pose_landmarker_lite float16 version 1, downloaded from https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task. SHA-256: 59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbbf6753c459690d574a.
