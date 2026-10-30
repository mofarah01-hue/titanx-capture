// Send one recorded session to the PC receiver (tools/receive.mjs) as a single zip.
//
// Why a plain fetch works from the iPad app: the page is served on jabarin-titanx://app/, so the receiver
// must be an https address with CORS (iOS App Transport Security blocks http:// to anything but loopback in
// a web view, and the Jabarin Info.plist has no exception). Publish the receiver with Tailscale Serve:
//   tailscale serve --bg --https=8447 http://127.0.0.1:8793
// and use https://fenan-desktop.tailcbb45a.ts.net:8447 as `url`. The receiver answers CORS for
// jabarin-titanx://app and wants the shared token as a Bearer header.
//
// Retrying is safe: every call makes one upload id and sends it with each try, and the receiver answers a
// repeated id with the first result instead of saving a second copy.
import { zipToBlob } from './zip.js';

/** Files that are bookkeeping, not data (same list as core/recorder.js zipEntries). */
const SKIP = new Set(['state.json', 'annotations.jsonl']);

export class UploadError extends Error {
  /** stage: 'config' | 'zip' | 'rejected' | 'unreachable' | 'server' */
  constructor(message, { stage, status = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UploadError';
    this.stage = stage;
    this.status = status;
  }
}

const isLoopback = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

function endpoint(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new UploadError(`The PC address "${url}" is not a valid web address.`, { stage: 'config' }); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new UploadError(`The PC address must start with https:// (iOS blocks plain http to the PC). Got ${u.protocol}//${u.host}. Use the Tailscale Serve https address.`, { stage: 'config' });
  }
  return u;
}

/** Everything in the session folder as zip entries, or a ready-made `<name>.zip` if the folder holds one. */
async function sessionPayload(dirHandle, sessionName) {
  let dir;
  try { dir = await dirHandle.getDirectoryHandle(sessionName); }
  catch (e) { throw new UploadError(`Session folder "${sessionName}" was not found in the save folder (${e.name || e.message}).`, { stage: 'zip', cause: e }); }
  const entries = [];
  let ready = null;
  for await (const [file, h] of dir.entries()) {
    if (h.kind !== 'file' || SKIP.has(file)) continue;
    const f = await h.getFile();
    if (file === `${sessionName}.zip`) { ready = f; continue; }
    entries.push({ name: `${sessionName}/${file}`, source: f, lastModified: new Date(f.lastModified) });
  }
  if (ready && !entries.some((e) => !/(^|\/)(manifest|annotations)\.json$/.test(e.name))) return ready; // the session's own zip is already the data
  if (!entries.length) throw new UploadError(`Session "${sessionName}" has no files to send.`, { stage: 'zip' });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  try { return await zipToBlob(entries); }
  catch (e) { throw new UploadError(`Could not zip session "${sessionName}": ${e.message}`, { stage: 'zip', cause: e }); }
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Zip the session folder `sessionName` inside `dirHandle` and POST it to the receiver.
 * @param {FileSystemDirectoryHandle} dirHandle  folder that CONTAINS the session folder
 * @param {string} sessionName
 * @param {{url: string, token: string, onProgress?: Function, retries?: number, baseDelayMs?: number, timeoutMs?: number, fetchImpl?: Function}} opts
 *   retries = extra tries after the first (default 4, waits 1 s, 2 s, 4 s, 8 s). onProgress gets
 *   {stage: 'zipping'|'sending'|'waiting'|'done', attempt, tries, bytes, delayMs, reason}.
 * @returns {Promise<{ok: true, bytes: number, where: string}>}
 * @throws {UploadError} naming what failed (config, zip, rejected, unreachable, server).
 */
export async function uploadSession(dirHandle, sessionName, { url, token, onProgress = () => {}, retries = 4, baseDelayMs = 1000, timeoutMs = 300000, fetchImpl } = {}) {
  if (!sessionName) throw new UploadError('No session name given.', { stage: 'config' });
  if (!token) throw new UploadError('No upload token set. Paste the token from the PC (tools/receive.token) into the settings.', { stage: 'config' });
  const base = endpoint(url);
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const emit = (p) => { try { onProgress(p); } catch { /* a progress callback must not break the upload */ } };

  emit({ stage: 'zipping' });
  const body = await sessionPayload(dirHandle, sessionName);
  const target = new URL(`${base.pathname.replace(/\/+$/, '')}/upload`, base);
  target.search = new URLSearchParams({ name: sessionName }).toString();
  const id = newId();
  const tries = retries + 1;

  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    emit({ stage: 'sending', attempt, tries, bytes: body.size });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(target.href, {
        method: 'POST', body, signal: ctl.signal, cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip', 'X-Upload-Id': id },
      });
    } catch (e) {
      clearTimeout(timer);
      last = new UploadError(`Could not reach the PC at ${base.host} after ${attempt} ${attempt === 1 ? 'try' : 'tries'} (${ctl.signal.aborted ? 'timed out' : e.message}). Check that Tailscale is on and the receiver is running; "Load failed" can also mean the address is not https or the receiver is not answering CORS.`, { stage: 'unreachable', cause: e });
      if (attempt < tries) { const delayMs = baseDelayMs * 2 ** (attempt - 1); emit({ stage: 'waiting', attempt, delayMs, reason: last.message }); await wait(delayMs); }
      continue;
    }
    clearTimeout(timer);
    let info = null, text = '';
    try { text = await res.text(); info = JSON.parse(text); } catch { /* not JSON */ }
    if (res.ok && info?.ok) {
      const out = { ok: true, bytes: body.size, where: `${info.saved} on ${base.host}` };
      emit({ stage: 'done', ...out });
      return out;
    }
    const detail = info?.error || text.slice(0, 160) || res.statusText;
    if (res.status >= 500) {
      last = new UploadError(`The PC receiver failed (HTTP ${res.status}: ${detail}) after ${attempt} ${attempt === 1 ? 'try' : 'tries'}.`, { stage: 'server', status: res.status });
      if (attempt < tries) { const delayMs = baseDelayMs * 2 ** (attempt - 1); emit({ stage: 'waiting', attempt, delayMs, reason: last.message }); await wait(delayMs); }
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new UploadError(`The PC refused the upload (HTTP ${res.status}: ${detail}). The token in the settings does not match the receiver's.`, { stage: 'rejected', status: res.status });
    throw new UploadError(`The PC rejected the upload (HTTP ${res.status}: ${detail}).`, { stage: 'rejected', status: res.status });
  }
  throw last;
}
