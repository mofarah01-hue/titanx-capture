// Past recordings: find them, read their CSVs back into the shape core/algo/motionhr.js runOffline
// wants. No DOM, no network. Two places hold runs:
//   device  OPFS `sessions/<name>/`: whole CSVs, written by core/recorder.js while recording
//   folder  the save folder, `<name>/`: `<name>.zip` once finished, `_live/<stem>.partNNNN.csv` while
//           recording or after a crash that never zipped
// Directory handles are passed in (or taken from the browser), so tests can use a fake tree.
import { crc32 } from './storage/zip.js';

const NOT_FOUND = (e) => e && e.name === 'NotFoundError';
const dec = new TextDecoder();

// ---------- CSV ----------
// Columns that are timing or bookkeeping, never signal.
const META = new Set(['i', 't_session_s', 't_sensor_ns', 't_sensor_ms', 't_sensor_us', 'rx_session_s']);

/**
 * Parse one stream CSV (header `i,t_session_s,...`). Signal columns are `opts.cols` (names) or every
 * column that is not timing. Returns { t: Float64Array, v: Float32Array (flat, ch per row), ch, rows, bad, gaps, cols }.
 *   gaps  rows with an empty wanted cell: a gap, left out, never filled in
 *   bad   rows that are short or not numbers, and an unterminated last line (the recorder always ends
 *         a line with \n, so a last line without one was cut off and its last number may be cut too)
 * Hand scanned with indexOf: an hour of Max mode ACC is 1.5 million lines, and split() per line is slow on an iPad.
 */
export function parseCsv(text, opts = {}) {
  const n = text.length;
  let nl = text.indexOf('\n');
  if (nl < 0) return { t: new Float64Array(0), v: new Float32Array(0), ch: 0, rows: 0, bad: n ? 1 : 0, gaps: 0, cols: [] };
  const head = text.slice(0, nl).replace(/\r$/, '').split(',').map((s) => s.trim());
  const tIdx = head.indexOf('t_session_s');
  if (tIdx < 0) throw new Error(`no t_session_s column (header: ${head.slice(0, 6).join(',')})`);
  const names = opts.cols || head.filter((h) => !META.has(h));
  const idx = names.map((c) => head.indexOf(c));
  if (!names.length || idx.some((i) => i < 0)) throw new Error(`missing column ${names.filter((_, k) => idx[k] < 0).join(', ') || '(none left after timing columns)'}`);
  const ch = names.length;
  // columns to read, in file order; slot -1 = time
  const want = [[tIdx, -1], ...idx.map((c, k) => [c, k])].sort((a, b) => a[0] - b[0]);
  let lines = 0; for (let p = nl; p >= 0; p = text.indexOf('\n', p + 1)) lines++;
  const T = new Float64Array(lines), V = new Float32Array(lines * ch), row = new Float64Array(ch + 1);
  let rows = 0, bad = 0, gaps = 0, pos = nl + 1;
  const complete = text.charCodeAt(n - 1) === 10;
  while (pos < n) {
    let e = text.indexOf('\n', pos);
    const last = e < 0;
    if (last) e = n;
    let end = e; if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    if (last && !complete) { if (end > pos) bad++; break; }
    if (end > pos) {
      let a = pos, col = 0, ok = true, gap = false;
      for (let w = 0; w < want.length && ok; w++) {
        while (col < want[w][0]) { const c = text.indexOf(',', a); if (c < 0 || c >= end) { ok = false; break; } a = c + 1; col++; }
        if (!ok) break;
        let c = text.indexOf(',', a); if (c < 0 || c > end) c = end;
        if (c === a) gap = true;
        else { const x = Number(text.slice(a, c)); if (Number.isFinite(x)) row[want[w][1] + 1] = x; else ok = false; }
      }
      if (!ok) bad++;
      else if (gap) gaps++;
      else { T[rows] = row[0]; for (let k = 0; k < ch; k++) V[rows * ch + k] = row[k + 1]; rows++; }
    }
    pos = e + 1;
  }
  return { t: T.subarray(0, rows), v: V.subarray(0, rows * ch), ch, rows, bad, gaps, cols: names };
}

// ---------- zip reader ----------
// Reads what core/storage/zip.js writes (deflate, sizes in the central directory) and also stored entries.
// No ZIP64: the writer has none either.
const u16 = (d, o) => d.getUint16(o, true), u32 = (d, o) => d.getUint32(o, true);

/** Open a zip held in a Blob/File. Returns { entries: [{name, method, crc, compressed, size, offset}], read(name) -> Uint8Array }. */
export async function openZip(blob) {
  const size = blob.size, tailN = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailN).arrayBuffer());
  let e = -1;
  for (let i = tailN - 22; i >= 0; i--) if (u32(tail, i) === 0x06054B50) { e = i; break; }
  if (e < 0) throw new Error('not a zip file (no end of central directory)');
  const count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (cdOff + cdSize > size) throw new Error('zip is cut short (central directory is past the end of the file)');
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = [];
  for (let p = 0, k = 0; k < count; k++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== 0x02014B50) throw new Error('zip central directory is damaged');
    const nameLen = u16(cd, p + 28), extra = u16(cd, p + 30), cmt = u16(cd, p + 32);
    entries.push({
      name: dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen)), method: u16(cd, p + 10), crc: u32(cd, p + 16),
      compressed: u32(cd, p + 20), size: u32(cd, p + 24), offset: u32(cd, p + 42),
    });
    p += 46 + nameLen + extra + cmt;
  }
  return {
    entries,
    /** Whole entry, checked against its size and CRC: a damaged zip throws, it never returns wrong bytes. */
    async read(name) {
      const en = entries.find((x) => x.name === name);
      if (!en) throw new Error(`${name} is not in the zip`);
      const lh = new DataView(await blob.slice(en.offset, en.offset + 30).arrayBuffer());
      if (u32(lh, 0) !== 0x04034B50) throw new Error(`${name}: local header is damaged`);
      const start = en.offset + 30 + u16(lh, 26) + u16(lh, 28), raw = blob.slice(start, start + en.compressed);
      let bytes;
      if (en.method === 0) bytes = new Uint8Array(await raw.arrayBuffer());
      else if (en.method === 8) bytes = new Uint8Array(await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw new Error(`${name}: compression method ${en.method} is not supported`);
      if (bytes.length !== en.size) throw new Error(`${name}: ${bytes.length} bytes after unzipping, expected ${en.size}`);
      if (crc32(bytes) !== en.crc) throw new Error(`${name}: checksum does not match, the zip is damaged`);
      return bytes;
    },
  };
}

// ---------- one run's files ----------
async function readJson(dir, name) {
  let f;
  try { f = await (await dir.getFileHandle(name)).getFile(); } catch (e) { if (NOT_FOUND(e)) return undefined; throw e; }
  try { return JSON.parse(await f.text()); } catch (e) { throw new Error(`${name} is not valid JSON (${e.message})`); }
}
const fileText = async (h) => (await h.getFile()).text();
const base = (p) => p.split('/').pop();

/**
 * Everything one run folder offers, whichever shape it is in. Where the same stream exists twice the
 * most complete wins: loose CSV, then the zip, then _live parts.
 * Returns { manifest, notes: Map, stems: [...], text(stem), annotations() }.
 */
async function makeSource(dir, manifest) {
  const files = new Map(); let live = null;
  for await (const [n, h] of dir.entries()) { if (h.kind === 'file') files.set(n, h); else if (n === '_live') live = h; }
  const loaders = new Map(), notes = new Map();   // notes: stem -> what is wrong with it, set when it is read
  if (live) {
    const groups = new Map();
    for await (const [n, h] of live.entries()) {
      const m = h.kind === 'file' && /^(.+)\.part(\d+)\.csv$/.exec(n);
      if (m) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push([Number(m[2]), h]); }
    }
    for (const [stem, ps] of groups) {
      ps.sort((a, b) => a[0] - b[0]);   // directory order is arbitrary; parts only make sense in order, and only the first has the header
      loaders.set(stem, async () => {
        if (ps.some(([no], k) => no !== k + 1)) notes.set(stem, `${stem}: part files ${ps.map((p) => p[0]).join(', ')} found, some are missing, so this stream has holes`);
        let s = ''; for (const [, h] of ps) s += await fileText(h);
        return s;
      });
    }
  }
  const zipH = files.get(`${manifest.session?.name}.zip`) || [...files].find(([n]) => n.endsWith('.zip'))?.[1];
  let zip = null;
  if (zipH) {
    zip = await openZip(await zipH.getFile());
    for (const en of zip.entries) if (en.name.endsWith('.csv')) loaders.set(base(en.name).slice(0, -4), async () => dec.decode(await zip.read(en.name)));
  }
  for (const [n, h] of files) if (n.endsWith('.csv')) loaders.set(n.slice(0, -4), () => fileText(h));
  return {
    manifest, notes, stems: [...loaders.keys()], text: (stem) => loaders.get(stem)(),
    async annotations() {
      const j = await readJson(dir, 'annotations.json');
      if (Array.isArray(j)) return j;
      if (zip) { const en = zip.entries.find((x) => base(x.name) === 'annotations.json'); if (en) return JSON.parse(dec.decode(await zip.read(en.name))); }
      const h = files.get('annotations.jsonl');
      return h ? (await fileText(h)).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}

// ---------- listing ----------
function summarize(name, manifest, source, finished, parent, dir) {
  const s = manifest.session || {};
  const devices = (manifest.devices || []).map((d) => ({
    id: d.device_id, kind: d.kind || 'polar', athlete: d.athlete || 'unassigned', mode: d.mode || null,
    streams: Object.entries(d.streams || {}).filter(([, st]) => st && st.file).map(([k]) => k),
  }));
  // a run that never closed has no duration: longest stream, samples over measured rate
  let durationS = s.duration_s ?? null;
  if (durationS == null) {
    for (const d of manifest.devices || []) for (const st of Object.values(d.streams || {})) if (st?.samples && st.measured_hz) durationS = Math.max(durationS ?? 0, st.samples / st.measured_hz);
  }
  let src;
  return { name, label: s.label || name, started: s.started || null, durationS, devices, source, finished, parent, dir, open: () => (src ||= makeSource(dir, manifest).catch((e) => { src = null; throw e; })) };
}

/**
 * Runs on this device and in the save folder, newest first.
 *   opfs: true (this browser's private storage), or a directory handle that stands for `sessions/`
 *   folder: the save folder handle, or null
 * A run in both places is listed once, as 'device' with `also: 'folder'`. Problems with single runs do
 * not stop the list: they come back in `result.errors`.
 * `parent` + `name` is what core/storage/upload.js uploadSession(parent, name) wants.
 */
export async function listRuns({ opfs = false, folder = null } = {}) {
  const out = [], errors = [];
  const scan = async (root, source) => {
    for await (const [name, h] of root.entries()) {
      if (h.kind !== 'directory' || name.startsWith('_') || name.startsWith('.')) continue;
      try {
        const manifest = await readJson(h, 'manifest.json');
        if (!manifest) continue;                       // not a session folder
        let finished, hasZip = false;
        if (source === 'device') finished = !!(await readJson(h, 'state.json'))?.finalized;
        else { for await (const [n] of h.entries()) if (n.endsWith('.zip')) hasZip = true; finished = hasZip; }
        out.push(summarize(name, manifest, source, finished, root, h));
      } catch (e) { errors.push(`${source === 'device' ? 'This device' : 'Save folder'}, ${name}: ${e.message}`); }
    }
  };
  if (opfs) {
    try {
      const dir = opfs === true ? await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions') : opfs;
      await scan(dir, 'device');
    } catch (e) { if (!NOT_FOUND(e)) errors.push(`This device: ${e.message}`); }
  }
  if (folder) { try { await scan(folder, 'folder'); } catch (e) { errors.push(`Save folder: ${e.name === 'NotAllowedError' ? 'permission to the folder was lost, allow it again in Setup' : e.message}`); } }
  const seen = new Map(), runs = [];
  for (const r of out) {
    const prev = seen.get(r.name);
    if (prev) { prev.also = 'folder'; continue; }
    seen.set(r.name, r); runs.push(r);
  }
  runs.sort((a, b) => (b.started || '').localeCompare(a.started || '') || a.name.localeCompare(b.name));
  runs.errors = errors;
  return runs;
}

// ---------- loading ----------
const SIGNAL = ['ppg', 'ppg_red', 'ppg_ir', 'acc', 'gyro', 'mag'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The files of one stream, oldest first. The manifest names only the newest file when the layout changed mid run (`..._ppg_2`). */
function filesOf(src, stem, key) {
  const root = stem.replace(new RegExp(`(_${esc(key)})_\\d+$`), '$1'), re = new RegExp(`^${esc(root)}(?:_(\\d+))?$`);
  return src.stems.map((s) => [s, re.exec(s)]).filter(([, m]) => m).sort((a, b) => Number(a[1][1] || 0) - Number(b[1][1] || 0)).map(([s]) => s);
}

function join(parts, warn, key) {
  const ok = parts.filter((p) => { if (p.ch === parts[0].ch) return true; warn(`${key}: a later file has ${p.ch} columns instead of ${parts[0].ch}, left out`); return false; });
  if (ok.length === 1) return ok[0];
  const rows = ok.reduce((s, p) => s + p.rows, 0), ch = ok[0].ch, t = new Float64Array(rows), v = new Float32Array(rows * ch);
  let o = 0; for (const p of ok) { t.set(p.t, o); v.set(p.v, o * ch); o += p.rows; }
  return { t, v, ch, rows, bad: ok.reduce((s, p) => s + p.bad, 0), gaps: ok.reduce((s, p) => s + p.gaps, 0) };
}

/**
 * One device of a run, ready for runOffline.
 * Returns { deviceId, kind, athlete, streams: {ppg, acc, ...: {t, v, ch}}, polarHr: {t, v, ch: 1} | null,
 *   marks: [{t, label, text, target}], dropouts: [...manifest dropouts of this device, plus t and to],
 *   stats: {key: {rows, bad, gaps, files}}, warnings: [text] }
 * Anything not read cleanly is in warnings; nothing is dropped without a count.
 */
export async function loadRun(run, deviceId) {
  const src = await run.open(), man = src.manifest;
  const dev = (man.devices || []).find((d) => d.device_id === deviceId);
  if (!dev) throw new Error(`Device ${deviceId} is not in run ${run.name}.`);
  const warnings = [], warn = (w) => warnings.push(w);
  const streams = {}, stats = {}; let polarHr = null;
  for (const key of [...SIGNAL, 'hr']) {
    const spec = dev.streams?.[key];
    if (!spec?.file) continue;
    const names = filesOf(src, spec.file.replace(/\.csv$/, ''), key);
    if (!names.length) { warn(`${key}: ${spec.file} is not in this run`); continue; }
    const parts = [];
    for (const nm of names) {
      try { parts.push(parseCsv(await src.text(nm), key === 'hr' ? { cols: ['hr_bpm'] } : {})); } catch (e) { warn(`${key}: ${nm} could not be read (${e.message})`); }
      if (src.notes.has(nm)) warn(src.notes.get(nm));
    }
    if (!parts.length) continue;
    const p = join(parts, warn, key);
    stats[key] = { rows: p.rows, bad: p.bad, gaps: p.gaps, files: names.length };
    if (p.bad || p.gaps) warn(`${key}: ${p.bad} unreadable lines and ${p.gaps} lines with empty cells were left out`);
    if (key === 'hr') polarHr = { t: p.t, v: p.v, ch: 1 }; else streams[key] = { t: p.t, v: p.v, ch: p.ch };
  }
  let notes = [];
  try { notes = await src.annotations(); } catch (e) { warn(`marks could not be read (${e.message})`); }
  const marks = notes
    .filter((m) => m.target == null || m.target === 'all' || m.target === dev.athlete_id)
    .map((m) => ({ t: m.t_session_s ?? m.t, label: m.label, text: m.text, target: m.target }))
    .filter((m) => Number.isFinite(m.t));
  const dropouts = (man.dropouts || []).filter((d) => d.device_id === deviceId)
    .map((d) => ({ ...d, t: d.kind === 'link' ? d.from_session_s : d.at_session_s, to: d.kind === 'link' ? d.to_session_s : null }));
  return { deviceId, kind: dev.kind || 'polar', athlete: dev.athlete || 'unassigned', streams, polarHr, marks, dropouts, stats, warnings };
}
