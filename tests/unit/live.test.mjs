// Live copy to the PC: the real receiver (tools/receive.mjs /live) on a random local port and the real
// core/storage/live.js, with a flaky network in between. Every test names the bug it would catch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver } from '../../tools/receive.mjs';
import { createLive } from '../../core/storage/live.js';

const TOKEN = 'test-token-0123456789abcdef';
let out, live, server, base;
before(async () => {
  out = mkdtempSync(join(tmpdir(), 'tx-recv-'));
  live = mkdtempSync(join(tmpdir(), 'tx-live-'));
  server = createReceiver({ token: TOKEN, outDir: out, liveDir: live, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Catches: bytes written twice after a retry whose answer was lost, bytes lost or out of order after the PC
// was unreachable, a manifest that is not the newest one, a session that never says it ended.
test('flaky network: the PC copy ends byte for byte equal to what was recorded', async () => {
  let n = 0;
  const flaky = async (url, opt) => {
    n++;
    if (n % 5 === 2) throw new TypeError('network down');                   // request never arrives
    const r = await fetch(url, opt);
    if (n % 7 === 3) throw new TypeError('answer lost');                    // PC wrote it, phone did not hear
    return r;
  };
  const states = [];
  const L = createLive({ url: base, token: TOKEN, session: 'sa7a_2026-10-30_0900_test', fetchImpl: flaky, onStatus: (s) => states.push(s.state) });
  const sent = { 'C8A1_ppg.csv': [], 'annotations.jsonl': [] };
  const push = (f, text) => { sent[f].push(text); L.append(f, text); };
  push('C8A1_ppg.csv', 'i,t_session_s,t_sensor_ns,ppg0,ppg1,ppg2,ambient\n');
  for (let s = 0; s < 40; s++) {                                            // 40 "seconds"
    let rows = '';
    for (let k = 0; k < 176; k++) { const i = s * 176 + k; rows += `${i},${(i / 176).toFixed(5)},${788918400000000000n + BigInt(i) * 5681818n},${200000 + i % 997},190000,180000,9000\n`; }
    push('C8A1_ppg.csv', rows);
    if (s % 10 === 0) { push('annotations.jsonl', JSON.stringify({ t: s, label: `m${s}` }) + '\n'); L.replace('manifest.json', JSON.stringify({ n: s })); }
    await L.tick();
  }
  const end = await L.end(JSON.stringify({ n: 'final' }));
  const dir = join(live, 'sa7a_2026-10-30_0900_test');
  for (const f of Object.keys(sent)) assert.equal(readFileSync(join(dir, f), 'utf8'), sent[f].join(''), `${f} differs`);
  assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), '{"n":"final"}');
  assert.ok(existsSync(join(dir, '_ended.json')), 'no _ended.json');
  assert.equal(end.state, 'ended');
  assert.ok(states.includes('behind') || states.includes('error'), 'the flaky network was never noticed');
});

// Catches: a wrong token being retried forever (and the backlog growing) instead of stopping with a flag.
test('wrong token: live copy stops and says why', async () => {
  let last;
  const L = createLive({ url: base, token: 'wrong-token-0123456789', session: 'sa7a_x', onStatus: (s) => { last = s; } });
  L.append('a.csv', 'x\n');
  await L.tick();
  assert.equal(last.state, 'stopped');
  assert.match(last.error, /refused/);
});

// Catches: a session or file name that escapes the live folder.
test('names that leave the live folder are refused', async () => {
  for (const q of ['session=..&file=a.csv&offset=0', 'session=..%2Fx&file=a.csv&offset=0', 'session=ok&file=..%2Fa.csv&offset=0', 'session=ok&file=a.exe&offset=0', 'session=ok&file=a.csv&replace=1']) {
    const r = await fetch(`${base}/live?${q}`, { method: 'POST', body: 'x', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 400, q);
  }
});

// Catches: the phone keeping an endless backlog in memory when the PC is gone for good.
test('PC gone: the backlog is capped and the live copy stops, saying the recording is complete', async () => {
  let last;
  const L = createLive({ url: 'http://127.0.0.1:9', token: TOKEN, session: 'sa7a_y', fetchImpl: async () => { throw new TypeError('down'); }, onStatus: (s) => { last = s; } });
  const mb = 'x'.repeat(1024 * 1024 - 1) + '\n';
  for (let i = 0; i < 70; i++) { L.append('a.csv', mb); if (i % 10 === 0) await L.tick(); }
  assert.equal(last.state, 'stopped');
  assert.match(last.error, /recording on this device is complete/);
});
