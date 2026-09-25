// The save folder: picked once, handle kept in IndexedDB, permission checked on every launch.
// Main thread only (requestPermission needs a click). The capture worker gets the handle by
// postMessage once permission is granted.
import { kvGet, kvSet, kvDel } from './kv.js';
import { REGISTRY_FILE } from '../registry.js';

const KEY = 'saveFolder';
export const CHECK_FILE = '_sa7a_check.txt';

/** { handle, name, permission: 'granted'|'prompt'|'denied'|'none' } */
export async function folderState() {
  const handle = await kvGet(KEY);
  if (!handle) return { handle: null, name: '', permission: 'none' };
  let permission;
  try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch { permission = 'prompt'; }
  return { handle, name: handle.name, permission };
}

/** Opens Chrome's folder picker. Resolves null if the user closes it. */
export async function pickFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'sa7a-save', mode: 'readwrite' });
    await kvSet(KEY, handle);
    return handle;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

/** Must run inside a click handler. Chrome 122+ offers "Allow on every visit". */
export async function allowSaving(handle) {
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export const forgetFolder = () => kvDel(KEY);

/** Proves writing works: saves a small file, reads it back, compares. */
export async function writeTest(handle) {
  const text = `TitanX Capture write test\n${new Date().toISOString()}\n${navigator.userAgent}\n`;
  const fh = await handle.getFileHandle(CHECK_FILE, { create: true });
  const w = await fh.createWritable();
  try { await w.write(text); await w.close(); } catch (e) { try { await w.abort(); } catch { /* closed */ } throw e; }
  return (await (await fh.getFile()).text()) === text;
}

/**
 * A page cannot see where a folder is, only its name. The shared Sa7a folder is recognised by the
 * athlete list Mohammad keeps in it, which could only have arrived there through Google Drive.
 */
export async function isSharedFolder(handle) {
  try { await handle.getFileHandle(REGISTRY_FILE); return true; } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return false;
    throw e;
  }
}
