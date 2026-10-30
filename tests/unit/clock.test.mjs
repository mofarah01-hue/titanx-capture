// Reproduction of the iPad Max mode recording of 2026-10-29: the Verity Sense sent PPG at 176 samples per
// second, but its frame time stamps advanced at 55 Hz (Polar mode's rate). Timed by those stamps, the PPG
// plots scribbled. Failure caught: session times that go backwards or are spaced at the wrong rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame } from '../../core/pmd/encode.js';
import { MeasurementType as MT } from '../../core/pmd/constants.js';

const posted = [];
globalThis.self = { postMessage: (m) => posted.push(m) };
await import('../../core/capture-worker.js');
const send = (m) => self.onmessage({ data: m });
const settle = () => new Promise((r) => setTimeout(r, 250));

test('Max mode PPG whose sensor clock runs at 55 Hz while 176 samples/s arrive: times increase at 1/176 s', async () => {
  const id = 'C8A1F07D', N = 36, FS = 176, STAMP_HZ = 55, EPOCH = 788918400n * 10n ** 9n; // 2025, ns since 2000
  send({ type: 'init' });
  send({ type: 'device', id, kind: 'polar', mode: 'max' });
  send({ type: 'stream', id, key: 'ppg', cfg: { key: 'ppg', measType: MT.PPG, sampleRate: FS, factor: 1, mode: 'max' } });
  for (let f = 0; f < 600; f++) {                    // 600 frames x 36 = about 123 s
    const values = []; for (let i = 0; i < N; i++) { const k = f * N + i; values.push(200000 + 500 * Math.sin(k / 20), 190000, 180000, 9000); }
    const stamp = EPOCH + BigInt(Math.round(((f + 1) * N / STAMP_HZ) * 1e9));            // the sensor's wrong clock
    const rx = ((f + 1) * N) / FS + 0.03 + 0.02 * Math.abs(Math.sin(f * 1.7));            // true time plus radio delay
    const bytes = encodeFrame({ measType: MT.PPG, timestampNs: stamp, frameType: 0, compressed: true, resolution: 22, factor: 1, values });
    send({ type: 'packet', id, kind: 'pmd', rx, bytes: bytes.buffer });
    if (f % 20 === 0) await settle();
  }
  await settle(); await settle();
  const t = posted.filter((m) => m.type === 'display' && m.data?.ppg).flatMap((m) => [...m.data.ppg.t]);
  const last = t.slice(-176 * 60);                  // the last minute, after detection
  let back = 0; const gaps = [];
  for (let i = 1; i < last.length; i++) { const d = last[i] - last[i - 1]; if (d <= 0) back++; gaps.push(d); }
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  console.log(`last minute: ${last.length} samples, ${back} out of order, median spacing ${(med * 1000).toFixed(2)} ms (1/176 s = 5.68 ms)`);
  assert.equal(back, 0, `${back} samples went backwards in time`);
  assert.ok(Math.abs(med - 1 / FS) / (1 / FS) < 0.05, `median spacing ${(med * 1000).toFixed(2)} ms`);
  const span = last.at(-1) - last[0];
  assert.ok(Math.abs(span - last.length / FS) < 1, `a minute of samples spans ${span.toFixed(1)} s`);
  process.exit(0); // the worker keeps a 100 ms display timer running
});
