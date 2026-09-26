// Test helper for tools/faces.mjs (not used by the app).
import { detectFaces } from './faces.js';
onmessage = async (e) => {
  try {
    const bmp = await createImageBitmap(e.data.blob || e.data);
    const t = performance.now();
    const faces = await detectFaces(bmp);
    postMessage({ ok: true, faces, ms: performance.now() - t });
  } catch (err) { postMessage({ ok: false, err: String(err.stack || err) }); }
};
