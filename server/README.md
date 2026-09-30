---
title: LookMatch Deep Preset
emoji: 🎞️
colorFrom: gray
colorTo: yellow
sdk: gradio
sdk_version: 6.29.0
app_file: app.py
pinned: false
---

# LookMatch Deep Preset Space

Serves [Deep Preset](https://github.com/minhmanho/deep_preset) (non-commercial license) for LookMatch's
model assist. The Space's own page lives in this folder: `app.py`, `requirements.txt`, this README.

## Deploy
1. huggingface.co > New Space > SDK Gradio > hardware **ZeroGPU** (Pro) or CPU basic. Set it **Public**.
   The app is a static site, so a token in its JS would be visible to anyone. Public costs you nothing
   extra and the GPU quota is charged to the Space owner only while a call runs.
2. Upload the three files from this folder (web UI "Files" > "Add file", or `git push` to the Space repo).
   First boot downloads about 1 GB of weights from Google Drive and takes a few minutes.
3. In LookMatch: Settings > Model assist > paste the Space URL, like `https://<you>-<space>.hf.space`.

## Test
```
python3 - <<'PY'
import base64, json, urllib.request
b = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
u = 'https://<you>-<space>.hf.space/gradio_api/call/stylize'
r = urllib.request.urlopen(urllib.request.Request(u, json.dumps({'data': [b('photo.jpg'), b('ref.jpg')]}).encode(), {'Content-Type': 'application/json'}))
print(r.read())   # {"event_id": "..."}  then GET u + '/<event_id>' streams the result
PY
```
