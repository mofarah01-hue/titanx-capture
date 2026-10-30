// Live copy of a recording session to the PC, while it records. Runs in the capture worker beside
// SessionStore, which hands it every byte it writes (see core/recorder.js). The PC side is the /live
// endpoint of tools/receive.mjs; the layout it writes is described in
// TItan-X\MVP Technical Work\Live stream layout RevA 2026-10-30.md.
//
// About once a second each file's new bytes go to the PC as one POST that names the byte offset it starts
// at. The PC appends only what it does not have yet and answers with its file size, so a retry or a resend
// after a dropout never writes anything twice. Bytes are dropped here only once the PC has them.
// The recording on the iPad is always the full copy: if the PC falls more than MAX_BEHIND behind, the live
// copy stops (and says so), and the session can still be sent whole afterwards.

const enc = new TextEncoder();
const MAX_BEHIND = 64 * 1024 * 1024;
const MAX_POST = 4 * 1024 * 1024;

const isLoopback = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/**
 * @param {{url: string, token: string, session: string, fetchImpl?: Function, onStatus?: Function, timeoutMs?: number}} o
 *   onStatus gets {state: 'ok'|'behind'|'error'|'stopped'|'ended', behind, sent, lastOk, error}.
 */
export function createLive({ url, token, session, fetchImpl, onStatus = () => {}, timeoutMs = 15000 }) {
  const base = new URL(String(url));
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopback(base.hostname))) throw new Error(`Live stream needs an https:// PC address, got ${base.protocol}//${base.host}`);
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const files = new Map(); // name -> { acked: PC's size, chunks: [Uint8Array], pending: bytes not yet acked }
  const replaced = new Map(); // name -> text to put whole (manifest.json)
  const st = { state: 'ok', behind: 0, sent: 0, lastOk: 0, error: '' };
  let busy = null, stopped = false;
  const status = (p) => { Object.assign(st, p); try { onStatus({ ...st }); } catch { /* status display must not break the stream */ } };

  const endpoint = (q) => {
    const u = new URL(`${base.pathname.replace(/\/+$/, '')}/live`, base);
    u.searchParams.set('session', session);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
    return u;
  };

  async function post(q, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await doFetch(endpoint(q), { method: 'POST', body, signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`PC refused the live stream (${r.status}): ${j.error || 'check the token'}`), { fatal: true });
      if (!r.ok && r.status !== 409) throw new Error(`PC answered ${r.status}: ${j.error || ''}`);
      return { status: r.status, ...j };
    } finally { clearTimeout(timer); }
  }

  function take(f, n) { // the first n pending bytes as one array
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of f.chunks) { if (at >= n) break; const k = Math.min(c.length, n - at); out.set(c.subarray(0, k), at); at += k; }
    return out;
  }

  function drop(f, n) { // forget the first n pending bytes (the PC has them)
    f.pending -= n;
    while (n > 0 && f.chunks.length) {
      const c = f.chunks[0];
      if (c.length <= n) { n -= c.length; f.chunks.shift(); } else { f.chunks[0] = c.subarray(n); n = 0; }
    }
  }

  async function sendAll() {
    for (const [name, text] of [...replaced]) {
      const r = await post({ file: name, replace: 1 }, enc.encode(text));
      if (r.ok && replaced.get(name) === text) replaced.delete(name);
    }
    for (const [name, f] of files) {
      while (f.pending > 0) {
        const n = Math.min(f.pending, MAX_POST);
        const r = await post({ file: name, offset: f.acked }, take(f, n));
        const size = Number(r.size);
        if (!Number.isFinite(size)) throw new Error(`PC gave no size for ${name}`);
        if (size < f.acked) throw Object.assign(new Error(`PC copy of ${name} is shorter (${size} bytes) than it confirmed (${f.acked}); was the file moved?`), { fatal: true });
        const got = Math.min(size - f.acked, f.pending);
        drop(f, got); f.acked += got; st.sent += got;
        if (got === 0) throw new Error(`PC did not take ${name} at ${f.acked}`);
      }
    }
  }

  const behind = () => { let b = 0; for (const f of files.values()) b += f.pending; return b; };

  return {
    /** Bytes appended to a file (a CSV, annotations.jsonl). */
    append(name, bytes) {
      if (stopped) return;
      const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
      let f = files.get(name);
      if (!f) files.set(name, (f = { acked: 0, chunks: [], pending: 0 }));
      f.chunks.push(b.slice()); f.pending += b.length;
      if (behind() > MAX_BEHIND) { stopped = true; files.clear(); replaced.clear(); status({ state: 'stopped', behind: 0, error: `PC more than ${MAX_BEHIND >> 20} MB behind; live copy stopped. The recording on this device is complete.` }); }
    },
    /** A small file rewritten whole (manifest.json). */
    replace(name, text) { if (!stopped) replaced.set(name, text); },
    /** Send what is waiting. Call about once a second; overlapping calls share one send. */
    tick() {
      if (stopped || busy) return busy;
      busy = (async () => {
        try { await sendAll(); status({ state: 'ok', behind: 0, lastOk: Date.now(), error: '' }); }
        catch (e) {
          const b = behind();
          if (e.fatal) { stopped = true; files.clear(); replaced.clear(); status({ state: 'stopped', behind: 0, error: e.message }); }
          else status({ state: b ? 'behind' : 'error', behind: b, error: e.name === 'AbortError' ? 'PC did not answer in time' : e.message });
        } finally { busy = null; }
      })();
      return busy;
    },
    /** Last send, then tell the PC the session is closed. Gives up after `ms`. */
    async end(manifestText, ms = 10000) {
      if (stopped) return { ...st };
      if (manifestText) replaced.set('manifest.json', manifestText);
      const until = Date.now() + ms;
      while (Date.now() < until) { await busy; await this.tick(); if (!behind() && !replaced.size) break; await new Promise((r) => setTimeout(r, 500)); }
      if (!behind() && !replaced.size) {
        try { await post({ end: 1 }, new Uint8Array(0)); status({ state: 'ended' }); } catch (e) { status({ state: 'error', error: `end not confirmed: ${e.message}` }); }
      }
      stopped = true;
      return { ...st };
    },
    get status() { return { ...st }; },
  };
}
