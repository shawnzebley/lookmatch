// Model assist client: asks the Deep Preset Space (server/app.py) to restyle a photo toward a reference.
// Plain fetch against Gradio's /gradio_api/call API, images as base64 JPEG in text fields.

const b64 = async (blob) => {
  const u = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** photo, ref: JPEG Blobs. Returns the restyled photo as a JPEG Blob. */
export async function stylizeRemote(base, photo, ref, { timeoutMs = 120000 } = {}) {
  const root = base.trim().replace(/\/+$/, '');
  const url = `${root}/gradio_api/call/stylize`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal, body: JSON.stringify({ data: [await b64(photo), await b64(ref)] }) });
    if (!r.ok) throw new Error(`Model server answered ${r.status}`);
    const { event_id } = await r.json();
    const s = await fetch(`${url}/${event_id}`, { signal: ctl.signal });
    if (!s.ok) throw new Error(`Model server answered ${s.status}`);
    const text = await s.text();
    // server-sent events: "event: complete\ndata: [\"<b64>\"]" or "event: error\ndata: ..."
    const ev = /event: (\w+)\s*\ndata: ([^\n]*)/g;
    let m, out = null, err = null;
    while ((m = ev.exec(text))) {
      if (m[1] === 'complete') out = m[2];
      else if (m[1] === 'error') err = m[2];
    }
    if (!out) {
      let why = err && err !== 'null' ? err : '';
      try { why = JSON.parse(why).error || why; } catch (e) { /* plain text */ }
      throw new Error(`Model server failed${why ? `: ${why}` : ''}`);
    }
    const data = JSON.parse(out)[0];
    const bin = atob(data), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: 'image/jpeg' });
  } finally { clearTimeout(timer); }
}
