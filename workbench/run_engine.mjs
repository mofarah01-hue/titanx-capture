// The iPad engine, unchanged, as a baseline for the workbench: reads one device's streams from stdin,
// runs core/algo/motionhr.js runOffline, writes the per second estimates and the Viterbi path as JSON.
// stdin: one JSON header line { kind, cfg, streams: [{ key, n, ch }] }, then per stream n float64 times
// (t_session_s) followed by n * ch float32 values, little endian. Float32 values are what core/runs.js
// parseCsv hands runOffline in the app, so the numbers match the iPad's own replay.
import { runOffline } from '../core/algo/motionhr.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const buf = Buffer.concat(chunks);
const nl = buf.indexOf(10);
if (nl < 0) { console.error('run_engine: no header line on stdin'); process.exit(2); }
const head = JSON.parse(buf.subarray(0, nl).toString('utf8'));
let o = nl + 1;
const take = (bytes, Type) => {
  if (o + bytes > buf.length) throw new Error(`stdin ended early: wanted ${bytes} bytes at ${o} of ${buf.length}`);
  const ab = new ArrayBuffer(bytes); new Uint8Array(ab).set(buf.subarray(o, o + bytes)); o += bytes;   // copy: typed arrays need alignment
  return new Type(ab);
};
const streams = {};
for (const s of head.streams) {
  const t = take(s.n * 8, Float64Array), v = take(s.n * s.ch * 4, Float32Array);
  streams[s.key] = { t, v, ch: s.ch };
}
const t0 = Date.now();
const r = runOffline(streams, head.kind || 'polar', head.cfg || undefined);
const est = r.est.map((e) => ({ t: e.t, bpm: e.bpm, tracked: e.tracked, conf: e.conf, why: e.why, spec: e.spec, peaks: e.peaks, motionG: e.motionG }));
process.stdout.write(JSON.stringify({ est, post: r.post, ms: Date.now() - t0 }));
