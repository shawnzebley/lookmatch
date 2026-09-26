// Google Drive via OAuth 2.0 token (implicit) redirect flow, scope drive.file:
// the app can only see and write files it created.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const KEY = 'lm_drive_token';

export function redirectUri() { return location.origin + location.pathname; }

export function connect(clientId) {
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem('lm_oauth_state', state);
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
    include_granted_scopes: 'true', state, prompt: 'select_account',
  });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

// Call on startup: picks up #access_token after Google redirects back.
export function captureRedirect() {
  if (!location.hash.includes('access_token') && !location.hash.includes('error=')) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (h.get('error')) return { error: h.get('error') };
  const want = sessionStorage.getItem('lm_oauth_state');
  if (want && h.get('state') !== want) return { error: 'state mismatch' };
  const tok = { token: h.get('access_token'), exp: Date.now() + (+h.get('expires_in') || 3600) * 1000 };
  localStorage.setItem(KEY, JSON.stringify(tok));
  return { ok: true };
}

export function token() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (t && t.exp > Date.now() + 60_000) return t.token;
  } catch (e) { /* ignore */ }
  return null;
}
export function minutesLeft() {
  try { const t = JSON.parse(localStorage.getItem(KEY) || 'null'); return t ? Math.max(0, Math.round((t.exp - Date.now()) / 60000)) : 0; } catch (e) { return 0; }
}
export function disconnect() {
  const t = token();
  localStorage.removeItem(KEY);
  if (t) fetch(`https://oauth2.googleapis.com/revoke?token=${t}`, { method: 'POST' }).catch(() => {});
}

async function api(url, opts = {}) {
  const t = token();
  if (!t) throw new Error('Google Drive sign-in expired. Connect again in Settings.');
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

const folderCache = new Map();
export async function folder(name, parentId = 'root') {
  const key = `${parentId}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  const j = await r.json();
  let id = j.files && j.files[0] && j.files[0].id;
  if (!id) {
    const c = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    id = (await c.json()).id;
  }
  folderCache.set(key, id);
  return id;
}

export async function upload(blob, name, parentId, mime = blob.type || 'application/octet-stream') {
  const meta = { name, parents: [parentId], mimeType: mime };
  try {
    const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
      body: JSON.stringify(meta),
    });
    const loc = r.headers.get('Location');
    if (loc) {
      const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
      if (!put.ok) throw new Error(`upload ${put.status}`);
      return (await put.json()).id;
    }
  } catch (e) {
    if (String(e).includes('sign-in')) throw e;
  }
  // fallback: multipart
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  fd.append('file', blob);
  const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: fd });
  return (await r.json()).id;
}

export async function listJson(parentId) {
  const q = `'${parentId}' in parents and trashed=false and mimeType='application/json'`;
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=200`);
  return (await r.json()).files || [];
}
export async function download(id) {
  const r = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return r.text();
}
export async function trash(id) {
  await api(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
}
export async function update(id, blob) {
  await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': blob.type }, body: blob });
}
