// PC side of "send session to PC": receives the zips that core/storage/upload.js posts from the iPad.
// No dependencies. Usage:
//   node tools/receive.mjs --new-token        once: writes tools/receive.token (git ignores it), never overwrites
//   node tools/receive.mjs [--port 8793] [--out DIR]
// Settings (flag wins over env): TITANX_RECEIVE_TOKEN or tools/receive.token, TITANX_RECEIVE_PORT (8793),
// TITANX_RECEIVE_OUT (C:\Users\<you>\Documents\TitanX-recordings), TITANX_RECEIVE_HOST (127.0.0.1),
// TITANX_RECEIVE_ORIGINS (comma list, default jabarin-titanx://app), TITANX_RECEIVE_MAX_MB (1024).
// It listens on 127.0.0.1 only; reach it from the iPad with Tailscale Serve (https, tailnet only):
//   tailscale serve --bg --https=8447 http://127.0.0.1:8793
// Rules: wrong or missing token is refused; a name that already exists gets a suffix (-2, -3), nothing is
// overwritten; the same X-Upload-Id sent again (a retry) gets the first answer, not a second copy.
// Live copy (core/storage/live.js): POST /live?session=S&file=F&offset=N appends the bytes this PC does not have
// yet to <live dir>/S/F and answers with the file's size; replace=1 swaps a whole manifest.json in; end=1 writes
// S/_ended.json. Live dir: --live, TITANX_LIVE_DIR, default C:\TitanX-data\live. Layout:
// TItan-X\MVP Technical Work\Live stream layout RevA 2026-10-30.md.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, copyFile, link, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
export const TOKEN_FILE = join(HERE, 'receive.token');
const DEFAULT_ORIGIN = 'jabarin-titanx://app';
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A safe single file name stem from whatever the page sent. */
export function safeName(raw) {
  let n = String(raw ?? '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);
  if (!n) n = 'session';
  if (RESERVED.test(n.split('.')[0])) n = `_${n}`;
  return n;
}

const digest = (s) => createHash('sha256').update(String(s)).digest();
const tokenOk = (given, want) => timingSafeEqual(digest(given), digest(want));

/**
 * @param {{token: string, outDir: string, origins?: string[], maxBytes?: number, log?: (line: string) => void}} cfg
 * @returns {import('node:http').Server}
 */
export function createReceiver({ token, outDir, liveDir = defaultLiveDir(), origins = [DEFAULT_ORIGIN], maxBytes = 1024 * 1024 * 1024, log = console.log }) {
  if (!token) throw new Error('createReceiver needs a token');
  mkdirSync(outDir, { recursive: true });
  const live = liveWriter(liveDir, log);
  const seen = new Map(); // upload id -> first answer (so a retry does not save a second copy)
  const stamp = () => new Date().toISOString();

  async function place(tmp, stem) {
    for (let n = 1; ; n++) {
      const name = `${stem}${n === 1 ? '' : `-${n}`}.zip`;
      const dest = join(outDir, name);
      try { await link(tmp, dest); }
      catch (e) {
        if (e.code === 'EEXIST') continue;
        if (e.code === 'EPERM' || e.code === 'ENOSYS' || e.code === 'EXDEV' || e.code === 'ENOTSUP') { // no hard links here: exclusive copy instead
          try { await copyFile(tmp, dest, 1 /* COPYFILE_EXCL */); } catch (e2) { if (e2.code === 'EEXIST') continue; throw e2; }
        } else throw e;
      }
      await unlink(tmp).catch(() => {});
      return name;
    }
  }

  return createServer((req, res) => {
    const peer = req.socket.remoteAddress;
    const origin = req.headers.origin;
    const allowed = origin && origins.includes(origin);
    const send = (status, obj, why) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (allowed) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
      res.writeHead(status, headers).end(JSON.stringify(obj));
      if (why) log(`${stamp()} refused ${status} ${why} from ${peer}`);
    };
    const fail = (status, error, why = error) => { req.resume(); send(status, { ok: false, error }, why); };

    if (origin && !allowed) return fail(403, 'This web page may not use the receiver.', `origin ${origin.slice(0, 60)}`);

    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      const h = allowed ? {
        'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Id', 'Access-Control-Max-Age': '600',
      } : {};
      res.writeHead(204, h).end();
      return;
    }

    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !tokenOk(m[1], token)) return fail(401, 'Wrong or missing token.', 'bad token');

    if (req.method === 'GET' && url.pathname === '/ping') return send(200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/live') return live(req, url, send, fail);
    if (!(req.method === 'POST' && url.pathname === '/upload')) return fail(404, 'Not found.', `${req.method} ${url.pathname.slice(0, 40)}`);

    const id = req.headers['x-upload-id'];
    if (id !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail(400, 'Bad upload id.');
    if (id && seen.has(id)) { req.resume(); log(`${stamp()} repeat ${seen.get(id).saved} (retry of an upload already saved) from ${peer}`); return send(200, seen.get(id)); }

    const length = Number(req.headers['content-length']);
    if (!Number.isInteger(length) || length < 4) return fail(411, 'A zip with a Content-Length is required.', 'no content-length');
    if (length > maxBytes) return fail(413, `Too big (limit ${Math.round(maxBytes / 1048576)} MB).`, `too big ${length}`);

    const stem = safeName(url.searchParams.get('name'));
    const tmp = join(outDir, `.incoming-${randomUUID()}.part`);
    const out = createWriteStream(tmp, { flags: 'wx' });
    let got = 0, head = Buffer.alloc(0), dead = false;
    const drop = async (status, error, why) => { if (dead) return; dead = true; out.destroy(); await unlink(tmp).catch(() => {}); if (!res.writableEnded && !res.destroyed) fail(status, error, why); };
    req.on('data', (c) => { got += c.length; if (head.length < 4) head = Buffer.concat([head, c]).subarray(0, 4); });
    req.on('aborted', () => drop(400, 'Upload cut off.', `cut off after ${got} of ${length} bytes`));
    req.on('error', (e) => drop(400, 'Upload failed.', `read error ${e.code || e.message}`));
    out.on('error', (e) => drop(500, 'The PC could not write the file.', `write error ${e.code || e.message}`));
    req.pipe(out);
    out.on('finish', async () => {
      if (dead) return;
      dead = true;
      try {
        if (got !== length) { await unlink(tmp).catch(() => {}); return fail(400, `Got ${got} of ${length} bytes.`, `short body ${got}/${length}`); }
        if (head.toString('latin1') !== 'PK\x03\x04') { await unlink(tmp).catch(() => {}); return fail(400, 'That is not a zip file.', 'not a zip'); }
        const saved = await place(tmp, stem);
        const answer = { ok: true, saved, bytes: got };
        if (id) { seen.set(id, answer); if (seen.size > 500) seen.delete(seen.keys().next().value); }
        log(`${stamp()} saved ${saved} ${got} bytes from ${peer}`);
        send(200, answer);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        log(`${stamp()} error saving ${stem}: ${e.code || e.message}`);
        send(500, { ok: false, error: 'The PC could not save the file.' });
      }
    });
  });
}

export function defaultLiveDir() { return process.platform === 'win32' ? 'C:\\TitanX-data\\live' : join(homedir(), 'TitanX-data', 'live'); }

const LIVE_SESSION = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u;
const LIVE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(csv|jsonl|json)$/;
const LIVE_MAX = 8 * 1024 * 1024;

/** The /live handler. Appends are per file and in order, so two requests for one file never interleave. */
function liveWriter(liveDir, log) {
  const queues = new Map();
  const inOrder = (key, job) => { const run = (queues.get(key) || Promise.resolve()).then(job, job); queues.set(key, run.catch(() => {})); return run; };
  const stamp = () => new Date().toISOString();
  return (req, url, send, fail) => {
    const session = url.searchParams.get('session') || '';
    if (!LIVE_SESSION.test(session) || session.includes('..')) return fail(400, 'Bad session name.', `live session ${session.slice(0, 40)}`);
    const dir = join(liveDir, session);
    const length = Number(req.headers['content-length'] ?? 0);
    if (!Number.isInteger(length) || length < 0 || length > LIVE_MAX) return fail(413, `Live chunks are at most ${LIVE_MAX >> 20} MB.`, `live length ${length}`);
    const parts = []; let got = 0;
    req.on('data', (c) => { got += c.length; if (got <= LIVE_MAX) parts.push(c); });
    req.on('error', () => {});
    req.on('end', async () => {
      if (got !== length) return fail(400, `Got ${got} of ${length} bytes.`, `live short body ${got}/${length}`);
      const body = Buffer.concat(parts);
      try {
        await mkdir(dir, { recursive: true });
        if (url.searchParams.get('end') === '1') {
          await writeFile(join(dir, '_ended.json'), JSON.stringify({ ended: stamp() }) + '\n', { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
          log(`${stamp()} live ${session} ended`);
          return send(200, { ok: true });
        }
        const file = url.searchParams.get('file') || '';
        if (!LIVE_FILE.test(file)) return fail(400, 'Bad file name.', `live file ${file.slice(0, 40)}`);
        const path = join(dir, file);
        if (url.searchParams.get('replace') === '1') {
          if (file !== 'manifest.json') return fail(400, 'Only manifest.json is replaced whole.');
          await inOrder(path, async () => { const tmp = join(dir, `.${file}.${randomUUID()}.tmp`); await writeFile(tmp, body); await rename(tmp, path); });
          return send(200, { ok: true, size: body.length });
        }
        const offset = Number(url.searchParams.get('offset'));
        if (!Number.isInteger(offset) || offset < 0) return fail(400, 'Bad offset.');
        const r = await inOrder(path, async () => {
          let size = 0;
          try { size = (await stat(path)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (offset > size) return { status: 409, size };              // a gap: the phone resends from `size`
          const skip = size - offset;                                   // bytes this PC already has (a retry)
          if (skip < body.length) {
            if (size === 0) log(`${stamp()} live ${session}/${file} started`);
            await appendFile(path, body.subarray(skip));
          }
          return { status: 200, size: Math.max(size, offset + body.length) };
        });
        return send(r.status, { ok: r.status === 200, size: r.size });
      } catch (e) {
        log(`${stamp()} live ${session}: write error ${e.code || e.message}`);
        return send(500, { ok: false, error: 'The PC could not write the live file.' });
      }
    });
  };
}

// ---- command line ----
function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }

function readToken() {
  if (process.env.TITANX_RECEIVE_TOKEN) return process.env.TITANX_RECEIVE_TOKEN.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  return '';
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--new-token')) {
    try { writeFileSync(TOKEN_FILE, `${randomBytes(24).toString('base64url')}\n`, { flag: 'wx' }); }
    catch (e) { console.error(e.code === 'EEXIST' ? `${TOKEN_FILE} already exists; not touched.` : `Could not write ${TOKEN_FILE}: ${e.message}`); process.exit(1); }
    console.log(`Wrote ${TOKEN_FILE}. Open it, copy the one line into the app's "PC upload token" setting. It is not shown here.`);
    process.exit(0);
  }
  const token = readToken();
  if (token.length < 16) {
    console.error(`No usable token. Run: node tools/receive.mjs --new-token   (or set TITANX_RECEIVE_TOKEN, at least 16 characters)`);
    process.exit(1);
  }
  const outDir = resolve(arg('out') || process.env.TITANX_RECEIVE_OUT || join(homedir(), 'Documents', 'TitanX-recordings'));
  const port = Number(arg('port') || process.env.TITANX_RECEIVE_PORT || 8793);
  const host = process.env.TITANX_RECEIVE_HOST || '127.0.0.1';
  const origins = (process.env.TITANX_RECEIVE_ORIGINS || DEFAULT_ORIGIN).split(',').map((s) => s.trim()).filter(Boolean);
  const maxBytes = Number(process.env.TITANX_RECEIVE_MAX_MB || 1024) * 1048576;
  const liveDir = resolve(arg('live') || process.env.TITANX_LIVE_DIR || defaultLiveDir());
  const server = createReceiver({ token, outDir, liveDir, origins, maxBytes });
  server.on('error', (e) => { console.error(`Cannot listen on ${host}:${port} (${e.code || e.message}).`); process.exit(1); });
  server.requestTimeout = 0; // big uploads on a slow link
  server.listen(port, host, () => console.log(`${new Date().toISOString()} receiver on http://${host}:${port}, saving to ${outDir}, live copies to ${liveDir}, allowing ${origins.join(', ')}`));
}
