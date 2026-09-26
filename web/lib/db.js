// Preset storage in IndexedDB (device) — Drive keeps a backup copy.
const DB = 'lookmatch', STORE = 'presets';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
export const listPresets = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => b.created - a.created);
export const putPreset = (p) => tx('readwrite', (s) => s.put(p));
export const deletePreset = (id) => tx('readwrite', (s) => s.delete(id));
export async function persist() { try { return await navigator.storage?.persist?.(); } catch (e) { return false; } }
