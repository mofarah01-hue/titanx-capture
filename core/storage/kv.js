// Tiny IndexedDB key/value store for settings and the save folder handle (a directory handle can
// be stored in IndexedDB but not in localStorage). Recordings never live here; see recorder.js.
const DB = 'titanx-capture', STORE = 'kv';
let dbp = null;

function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const kvGet = (key) => tx('readonly', (s) => s.get(key));
export const kvSet = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const kvDel = (key) => tx('readwrite', (s) => s.delete(key));
/** Clears settings only (used by ?setup=reset). Recordings in OPFS are not touched. */
export const kvClear = () => tx('readwrite', (s) => s.clear());
