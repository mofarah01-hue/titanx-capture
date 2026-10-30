// Upload to the PC: the real receiver (tools/receive.mjs) on a random local port, the real upload.js, a fake
// session folder held in memory. Every test names the bug it would catch. Zip contents are checked with
// Python's zipfile (verifies CRCs); if Python is missing those checks are skipped, not passed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver, safeName } from '../../tools/receive.mjs';
import { uploadSession, UploadError } from '../../core/storage/upload.js';

const TOKEN = 'test-token-0123456789abcdef';
const ORIGIN = 'jabarin-titanx://app';
const PY = (() => { for (const p of ['python', 'python3']) { try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch { /* next */ } } return null; })();

/** In-memory stand in for an OPFS folder: getDirectoryHandle(name) and entries(). */
function fakeFolder(sessions) {
  const dirOf = (files) => ({
    kind: 'directory',
    async *entries() { for (const [n, bytes] of Object.entries(files)) yield [n, { kind: 'file', getFile: async () => new File([bytes], n, { lastModified: Date.UTC(2026, 9, 30) }) }]; },
  });
  return { async getDirectoryHandle(name) { if (!(name in sessions)) { const e = new Error('nope'); e.name = 'NotFoundError'; throw e; } return dirOf(sessions[name]); } };
}

const csv = new TextEncoder().encode('i,t_session_s,ppg0\n' + Array.from({ length: 5000 }, (_, i) => `${i},${(i / 55).toFixed(4)},${(Math.sin(i) * 1e5) | 0}`).join('\n') + '\n');
const noise = new Uint8Array(40000); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
const SESSION = {
  'manifest.json': new TextEncoder().encode('{"session":{"name":"sa7a_test"}}'),
  'C8A1B2E4_ppg.csv': csv,
  'raw.bin': noise,
  'state.json': new TextEncoder().encode('{"finalized":true}'),      // bookkeeping: must not be sent
  'annotations.jsonl': new TextEncoder().encode('{"t":1}\n'),         // bookkeeping: must not be sent
};
const folder = fakeFolder({ sa7a_test: SESSION, '../evil': SESSION });

let out, server, base;
before(async () => {
  out = mkdtempSync(join(tmpdir(), 'tx-recv-'));
  server = createReceiver({ token: TOKEN, outDir: out, origins: [ORIGIN], log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const files = () => readdirSync(out).sort();

function unzipTo(zipPath) {
  const dest = mkdtempSync(join(tmpdir(), 'tx-unz-'));
  execFileSync(PY, ['-m', 'zipfile', '-t', zipPath], { stdio: 'pipe' });
  execFileSync(PY, ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, dest]);
  return dest;
}

// Catches: bookkeeping files leaking into the zip, bytes changed or truncated on the way, a corrupt archive.
test('a session arrives intact, without bookkeeping files', { skip: PY ? false : 'python missing' }, async () => {
  const seen = [];
  const r = await uploadSession(folder, 'sa7a_test', { url: base, token: TOKEN, onProgress: (p) => seen.push(p.stage) });
  assert.equal(r.ok, true);
  assert.match(r.where, /^sa7a_test\.zip on 127\.0\.0\.1:/);
  assert.deepEqual(files(), ['sa7a_test.zip']);
  assert.equal(readFileSync(join(out, 'sa7a_test.zip')).length, r.bytes);
  assert.deepEqual(seen, ['zipping', 'sending', 'done']);
  const dest = unzipTo(join(out, 'sa7a_test.zip'));
  assert.deepEqual(readdirSync(join(dest, 'sa7a_test')).sort(), ['C8A1B2E4_ppg.csv', 'manifest.json', 'raw.bin']);
  assert.deepEqual(readFileSync(join(dest, 'sa7a_test', 'C8A1B2E4_ppg.csv')), Buffer.from(csv));
  assert.deepEqual(readFileSync(join(dest, 'sa7a_test', 'raw.bin')), Buffer.from(noise));
});

// Catches: the same name overwriting an earlier recording (data loss).
test('a second upload with the same name gets a suffix and the first stays untouched', async () => {
  const before1 = readFileSync(join(out, 'sa7a_test.zip'));
  const r = await uploadSession(folder, 'sa7a_test', { url: base, token: TOKEN });
  assert.match(r.where, /^sa7a_test-2\.zip /);
  assert.deepEqual(files(), ['sa7a_test-2.zip', 'sa7a_test.zip']);
  assert.deepEqual(readFileSync(join(out, 'sa7a_test.zip')), before1);
});

// Catches: a wrong token accepted, or refused but still written, or retried pointlessly.
test('a wrong token is refused, saves nothing and is not retried', async () => {
  const names = files();
  let calls = 0;
  const counting = (...a) => { calls++; return fetch(...a); };
  await assert.rejects(
    uploadSession(folder, 'sa7a_test', { url: base, token: 'x'.repeat(TOKEN.length), fetchImpl: counting, baseDelayMs: 1 }),
    (e) => e instanceof UploadError && e.stage === 'rejected' && e.status === 401 && /token/.test(e.message));
  assert.equal(calls, 1);
  assert.deepEqual(files(), names);
});

// Catches: a retry after a lost answer saving a second copy (the upload arrived, only the reply was lost).
test('a retry after a lost reply and after a 503 saves exactly one copy', async () => {
  const names = files();
  let n = 0;
  const flaky = async (u, init) => {
    n++;
    if (n === 1) return new Response('busy', { status: 503 });                   // server error before anything was sent
    const real = await fetch(u, init);                                             // the PC saved it ...
    if (n === 2) { await real.arrayBuffer(); throw new TypeError('Load failed'); } // ... but the answer never got back
    return real;
  };
  const waits = [];
  const r = await uploadSession(folder, 'sa7a_test', { url: base, token: TOKEN, fetchImpl: flaky, baseDelayMs: 1, onProgress: (p) => p.stage === 'waiting' && waits.push(p.delayMs) });
  assert.equal(n, 3);
  assert.deepEqual(waits, [1, 2]);                                                 // backoff doubles
  assert.match(r.where, /^sa7a_test-3\.zip /);
  assert.deepEqual(files(), [...names, 'sa7a_test-3.zip'].sort());                 // one new file, not two
});

// Catches: giving up silently, or a message that does not say what failed.
test('an unreachable PC gives up after the retries with a clear error', async () => {
  const dead = createReceiver({ token: TOKEN, outDir: out, log: () => {} });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
  await assert.rejects(
    uploadSession(folder, 'sa7a_test', { url, token: TOKEN, retries: 2, baseDelayMs: 1 }),
    (e) => e instanceof UploadError && e.stage === 'unreachable' && /Could not reach the PC at 127\.0\.0\.1/.test(e.message) && /3 tries/.test(e.message));
});

// Catches: bad settings failing as a vague network error, or sending the token over plain http to the tailnet.
test('settings problems and a missing session fail before any network call', async () => {
  const never = () => { throw new Error('network used'); };
  const stage = (opts, name = 'sa7a_test') => uploadSession(folder, name, { fetchImpl: never, ...opts }).then(() => 'ok', (e) => e.stage);
  assert.equal(await stage({ url: 'http://100.108.62.3:8793', token: TOKEN }), 'config');
  assert.equal(await stage({ url: 'not a url', token: TOKEN }), 'config');
  assert.equal(await stage({ url: base, token: '' }), 'config');
  assert.equal(await stage({ url: base, token: TOKEN }, 'no_such_session'), 'zip');
});

// Catches: a session name from the page escaping the output folder, or Windows reserved names.
test('hostile names stay inside the output folder', async () => {
  assert.equal(safeName('../../evil'), '_.._evil');
  assert.ok(!/[\\/]/.test(safeName('..\\..\\Windows\\x')));
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('   '), 'session');
  const before2 = files().length;
  const r = await uploadSession(folder, '../evil', { url: base, token: TOKEN });
  assert.ok(!r.where.includes('/') && !r.where.includes('\\'));
  assert.equal(files().length, before2 + 1);       // landed in `out`, nothing above it
  assert.ok(files().every((f) => !f.startsWith('.incoming-')), 'no temp file left behind');
});

// Catches: CORS wrong so the iPad page cannot read the answer; other web pages allowed in; garbage accepted as a recording.
test('CORS allows only the app origin, and a non zip body is refused', async () => {
  const ok = await fetch(`${base}/upload`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-upload-id' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/i);
  const bad = await fetch(`${base}/upload`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const post = await fetch(`${base}/upload?name=x`, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(100) });
  assert.equal(post.status, 403);
  const names = files();
  const junk = await fetch(`${base}/upload?name=junk`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(100) });
  assert.equal(junk.status, 400);
  assert.equal(junk.headers.get('access-control-allow-origin'), ORIGIN);   // errors are readable by the page too
  assert.deepEqual(files(), names);
});

test('--new-token writes a file once and never overwrites it', () => {
  // Catches: regenerating the token and locking the iPad out. Runs the CLI against a copy of the tools dir.
  const dir = mkdtempSync(join(tmpdir(), 'tx-tok-'));
  writeFileSync(join(dir, 'receive.mjs'), readFileSync(new URL('../../tools/receive.mjs', import.meta.url)));
  const run = () => { try { return { code: 0, out: execFileSync(process.execPath, [join(dir, 'receive.mjs'), '--new-token'], { stdio: 'pipe' }).toString() }; } catch (e) { return { code: e.status, out: String(e.stderr) }; } };
  const first = run();
  assert.equal(first.code, 0);
  const token = readFileSync(join(dir, 'receive.token'), 'utf8');
  assert.ok(token.trim().length >= 16);
  assert.ok(!first.out.includes(token.trim()), 'the token is not printed');
  const second = run();
  assert.equal(second.code, 1);
  assert.equal(readFileSync(join(dir, 'receive.token'), 'utf8'), token);
});
