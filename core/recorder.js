// Session store. Runs inside the capture worker, because OPFS sync access handles (true appends
// with a real flush) exist only in dedicated workers.
//
// Where data lives while recording:
//   1. OPFS (the browser's private disk area on this Mac): every row is appended and flushed
//      about once a second. This is the crash safe copy. A tab crash, browser crash or power cut
//      loses at most the last second, and the next launch finishes the session from here.
//   2. The Sa7a folder in Google Drive: manifest.json and annotations.json are rewritten at once
//      on every change, and every few minutes the new rows of each stream are copied as part
//      files into <session>/_live/. That way most of a session is already on its way to Mohammad
//      even if the Mac itself is lost.
// At the end the CSVs are zipped into <session>/<session>.zip, the zip is read back to check its
// size, and only then is _live removed.
//
// Why not stream straight into Drive: Chrome's createWritable() writes to a .crswap file that
// only becomes the real file on close(), so an open file is invisible and lost on a crash, and
// Google Drive would keep uploading the growing swap file.

import { writeZip } from './storage/zip.js';

const enc = new TextEncoder();
const LIVE = '_live';

/** Safe for file names on macOS, Windows and Google Drive. Keeps non Latin letters. */
export function safeName(s, fallback = 'session') {
  const t = String(s ?? '').normalize('NFC').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, '-').slice(0, 40);
  return t || fallback;
}

/** sa7a_YYYY-MM-DD_HHMM_<label>, local time. */
export function sessionName(label, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `sa7a_${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}_${safeName(label)}`;
}

async function driveDir(root, parts) {
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

/** Write a whole file into a Drive folder. `data`: string | Uint8Array | Blob | ReadableStream. */
async function driveWrite(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    if (data instanceof ReadableStream) { await data.pipeTo(w); return; } // pipeTo closes w
    await w.write(typeof data === 'string' ? enc.encode(data) : data);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* already closed */ }
    throw e;
  }
}

export class SessionStore {
  /** @param {{name: string, drive: FileSystemDirectoryHandle|null, checkpointEveryS?: number, onStatus?: Function}} o */
  static async start(o) {
    const root = await navigator.storage.getDirectory();
    const all = await root.getDirectoryHandle('sessions', { create: true });
    let name = o.name;
    for (let i = 2; await exists(all, name); i++) name = `${o.name}_${i}`;
    const dir = await all.getDirectoryHandle(name, { create: true });
    const s = new SessionStore(name, dir, o);
    await s.#localJson('state.json', { name, finalized: false, started: new Date().toISOString() });
    return s;
  }

  constructor(name, dir, o) {
    this.name = name;
    this.dir = dir;
    this.drive = o.drive || null;
    this.checkpointEveryMs = (o.checkpointEveryS ?? 300) * 1000;
    this.onStatus = o.onStatus || (() => {});
    this.live = o.live || null;  // live copy to the PC (core/storage/live.js): gets every byte written here
    this.streams = new Map();   // key -> { h, size, ckpt, part, rows }
    this.annotations = [];
    this.manifest = null;
    this.status = { local: 'ok', lastLocalWrite: 0, drive: this.drive ? 'ok' : 'none', lastDriveWrite: 0, driveError: '', bytes: 0 };
    this.lastCheckpoint = Date.now();
    this.driveQueue = Promise.resolve();
    this.localQueue = Promise.resolve();
  }

  // ---------- streams ----------
  async openStream(key, header) {
    if (this.streams.has(key)) return;
    const fh = await this.dir.getFileHandle(`${key}.csv`, { create: true });
    const h = await fh.createSyncAccessHandle();
    let size = h.getSize();
    if (size === 0) { const b = enc.encode(header.join(',') + '\n'); h.write(b, { at: 0 }); size = b.length; this.live?.append(`${key}.csv`, b); }
    this.streams.set(key, { h, size, ckpt: 0, part: 0, rows: 0 });
  }

  /** Append complete CSV lines (text ending in \n) to a stream. */
  append(key, text, rows) {
    const s = this.streams.get(key);
    if (!s) throw new Error(`Recorder: stream ${key} was never opened.`);
    const b = enc.encode(text);
    try {
      const n = s.h.write(b, { at: s.size });
      if (n !== b.length) throw new Error(`short write ${n} of ${b.length}`);
    } catch (e) {
      this.#setStatus({ local: 'error', driveError: this.status.driveError });
      throw new Error(`Could not save ${key} on this Mac (${e.name === 'QuotaExceededError' ? 'disk full' : e.message}).`);
    }
    s.size += b.length; s.rows += rows; this.status.bytes += b.length;
    this.live?.append(`${key}.csv`, b);
  }

  /** Make appended rows durable. Call about once a second. */
  flush() {
    for (const s of this.streams.values()) s.h.flush();
    this.#setStatus({ local: 'ok', lastLocalWrite: Date.now() });
    this.live?.tick();
    if (this.drive && Date.now() - this.lastCheckpoint >= this.checkpointEveryMs) this.checkpoint();
  }

  // ---------- small JSON records, written at once ----------
  async addAnnotation(mark) {
    this.annotations.push(mark);
    this.live?.append('annotations.jsonl', JSON.stringify(mark) + '\n');
    await this.#local(async () => {
      const h = await (await this.dir.getFileHandle('annotations.jsonl', { create: true })).createSyncAccessHandle();
      try { const b = enc.encode(JSON.stringify(mark) + '\n'); h.write(b, { at: h.getSize() }); h.flush(); } finally { h.close(); }
    });
    this.#toDrive(async (d) => driveWrite(d, 'annotations.json', JSON.stringify(this.annotations, null, 1)));
  }

  /** Rewrites manifest.json here and in Drive. Calls may overlap; each write takes the newest manifest. */
  setManifest(manifest) {
    this.manifest = manifest;
    this.live?.replace('manifest.json', JSON.stringify(manifest, null, 1));
    this.#toDrive(async (d) => driveWrite(d, 'manifest.json', JSON.stringify(this.manifest, null, 1)));
    return this.#local(() => localJson(this.dir, 'manifest.json', this.manifest));
  }

  // Small local files get one sync access handle at a time, in order: OPFS refuses a second one.
  #local(job) {
    const run = this.localQueue.then(job);
    this.localQueue = run.catch((e) => { this.#setStatus({ local: 'error' }); console.error('recorder:', e); });
    return run;
  }

  setDrive(handle) { this.drive = handle; this.#setStatus({ drive: handle ? 'ok' : 'none', driveError: '' }); }

  // ---------- Drive copies ----------
  /** Copy rows added since the last checkpoint of each stream into <session>/_live/. */
  checkpoint() {
    this.lastCheckpoint = Date.now();
    const chunks = [];
    for (const [key, s] of this.streams) {
      if (s.size === s.ckpt) continue;
      const buf = new Uint8Array(s.size - s.ckpt);
      s.h.read(buf, { at: s.ckpt });
      s.part += 1;
      chunks.push({ name: `${key}.part${String(s.part).padStart(4, '0')}.csv`, buf });
      s.ckpt = s.size;
    }
    if (chunks.length) this.#toDrive(async (d) => { const live = await driveDir(d, [LIVE]); for (const c of chunks) await driveWrite(live, c.name, c.buf); });
  }

  /** Close all streams, zip them into the Drive folder, verify, clean up. */
  async finalize(manifest) {
    await this.localQueue;
    for (const s of this.streams.values()) { s.h.flush(); s.h.close(); }
    this.streams.clear();
    this.manifest = manifest;
    await localJson(this.dir, 'manifest.json', manifest);
    await localJson(this.dir, 'annotations.json', this.annotations);
    if (this.live) this.liveResult = await this.live.end(JSON.stringify(manifest, null, 1));
    await this.driveQueue;
    if (!this.drive) { await markFinished(this.dir, this.name, { drive: false }); return { drive: false, reason: 'No save folder' }; }
    try {
      const res = await zipToDrive(this.dir, this.name, this.drive, manifest, this.annotations);
      await markFinished(this.dir, this.name, { drive: true });
      this.#setStatus({ drive: 'ok', lastDriveWrite: Date.now(), driveError: '' });
      return res;
    } catch (e) {
      this.#setStatus({ drive: 'error', driveError: e.message });
      return { drive: false, reason: e.message };
    }
  }

  // ---------- internals ----------
  #toDrive(job) {
    if (!this.drive) return;
    this.driveQueue = this.driveQueue.then(async () => {
      if (!this.drive) return;
      try {
        await job(await driveDir(this.drive, [this.name]));
        this.#setStatus({ drive: 'ok', lastDriveWrite: Date.now(), driveError: '' });
      } catch (e) {
        this.#setStatus({ drive: 'error', driveError: e.name === 'NotAllowedError' ? 'Permission to the Sa7a folder was lost' : e.message });
      }
    });
  }

  #localJson(name, obj) { return localJson(this.dir, name, obj); }

  #setStatus(p) { Object.assign(this.status, p); this.onStatus({ ...this.status }); }
}

async function localJson(dir, name, obj) {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  try { const b = enc.encode(JSON.stringify(obj, null, 1)); h.truncate(0); h.write(b, { at: 0 }); h.flush(); } finally { h.close(); }
}

async function readJson(dir, name) {
  try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch { return null; }
}

// state.json: finalized once the session is closed, drive once its zip is safely in the Drive folder.
// A session whose zip never reached Drive is retried at the next launch (see recoverSession).
async function markFinished(dir, name, { drive, recovered = false }) {
  await localJson(dir, 'state.json', { name, finalized: true, drive, recovered, ended: new Date().toISOString() });
}

/** Zip a local session folder into <drive>/<name>/<name>.zip, read the size back, then tidy up. */
async function zipToDrive(dir, name, drive, manifest, annotations) {
  const d = await driveDir(drive, [name]);
  const entries = await zipEntries(dir, name);
  const fh = await d.getFileHandle(`${name}.zip`, { create: true });
  const w = await fh.createWritable();
  let res;
  try { res = await writeZip(entries, w); await w.close(); } catch (e) { try { await w.abort(); } catch { /* closed */ } throw e; }
  const onDisk = (await fh.getFile()).size;
  if (onDisk !== res.bytes) throw new Error(`zip on disk is ${onDisk} bytes, expected ${res.bytes}`);
  await driveWrite(d, 'manifest.json', JSON.stringify(manifest, null, 1));
  await driveWrite(d, 'annotations.json', JSON.stringify(annotations, null, 1));
  try { await d.removeEntry(LIVE, { recursive: true }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  return { drive: true, zipBytes: res.bytes, files: res.entries };
}

/**
 * Finish a session the app never closed (crash, tab closed, power cut). Its rows are all in OPFS up
 * to the last flush. With a save folder it goes to Drive like any session; without one it stays
 * local and is tried again next launch.
 */
export async function recoverSession(name, drive) {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(name);
  const manifest = (await readJson(dir, 'manifest.json')) || { session: { name } };
  manifest.recovered = 'The app closed before this session was ended. Everything saved up to about one second before that is here.';
  let annotations = [];
  try { annotations = (await (await (await dir.getFileHandle('annotations.jsonl')).getFile()).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no marks */ }
  await localJson(dir, 'manifest.json', manifest);
  await localJson(dir, 'annotations.json', annotations);
  if (!drive) return { name, drive: false, reason: 'No save folder yet' };
  try {
    const res = await zipToDrive(dir, name, drive, manifest, annotations);
    await markFinished(dir, name, { drive: true, recovered: true });
    return { name, ...res };
  } catch (e) {
    return { name, drive: false, reason: e.message };
  }
}

async function exists(dir, name) {
  try { await dir.getDirectoryHandle(name); return true; } catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
}

/** Zip entries for everything in a local session folder except bookkeeping files. */
async function zipEntries(dir, name) {
  const entries = [];
  for await (const [file, h] of dir.entries()) {
    if (h.kind !== 'file' || file === 'state.json' || file === 'annotations.jsonl') continue;
    const f = await h.getFile();
    entries.push({ name: `${name}/${file}`, source: f, lastModified: new Date(f.lastModified) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** Sessions left unfinished by a crash, or finished but not yet in the Drive folder. */
export async function unfinishedSessions() {
  const root = await navigator.storage.getDirectory();
  const all = await root.getDirectoryHandle('sessions', { create: true });
  const out = [];
  for await (const [name, h] of all.entries()) {
    if (h.kind !== 'directory') continue;
    try {
      const st = JSON.parse(await (await (await h.getFileHandle('state.json')).getFile()).text());
      if (!st.finalized || st.drive === false) out.push({ name, started: st.started, finalized: !!st.finalized });
    } catch { out.push({ name, started: null }); }
  }
  return out;
}

/** Keep the newest `keep` sessions that reached Drive as a local backup, delete older ones. Never deletes one that did not reach Drive. */
export async function pruneFinished(keep = 3) {
  const root = await navigator.storage.getDirectory();
  const all = await root.getDirectoryHandle('sessions', { create: true });
  const done = [];
  for await (const [name, h] of all.entries()) {
    if (h.kind !== 'directory') continue;
    try { const st = JSON.parse(await (await (await h.getFileHandle('state.json')).getFile()).text()); if (st.finalized && st.drive) done.push({ name, ended: st.ended || '' }); } catch { /* unreadable: leave it */ }
  }
  done.sort((a, b) => b.ended.localeCompare(a.ended));
  for (const d of done.slice(keep)) await all.removeEntry(d.name, { recursive: true });
}
