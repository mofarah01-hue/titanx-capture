// Capture worker: every packet from every sensor comes here. It decodes, times, checks and records;
// the page only draws. One worker serves all sensors.
//
// Timing. Each sample keeps the sensor's own timestamp (t_sensor_ns, ns since 2000-01-01 on the
// sensor's clock) and gets a session time (t_session_s, seconds since the session started on this
// laptop's monotonic clock). session = sensor + offset, where offset is the smallest
// (receive time minus sensor time) seen over the last 30 s: the least delayed packet is the best
// estimate, and the window follows slow clock drift. The offset applied moves towards it at most
// 10 ms per second, so session time never runs backwards within a stream. frames.csv keeps every packet's receive time
// so the mapping can be redone later.
//
// Gaps. PMD frames carry no sequence number. A frame whose samples would be spread over more than
// 1.5 sample periods each means frames were lost: its samples are re-timed backwards from its own
// timestamp at the measured rate, the gap goes in the manifest, and nothing is filled in.

import { parseFrame, decodeFrame } from './pmd/decode.js';
import { MeasurementType as MT, MEASUREMENT_TYPE_NAME } from './pmd/constants.js';
import { parseHeartRateMeasurement, parseBatteryLevel } from './ble/gatt-parse.js';
import { SessionStore, sessionName, safeName, unfinishedSessions, recoverSession } from './recorder.js';
import { zipToBlob } from './storage/zip.js';
import * as SW from './senswear/protocol.js';

const KEY = { [MT.PPG]: 'ppg', [MT.ACC]: 'acc', [MT.GYRO]: 'gyro', [MT.MAG]: 'mag', [MT.PPI]: 'ppi' };
const UNIT_COLS = {
  acc: (n) => n.map((c) => `${c}_mg`), gyro: (n) => n.map((c) => `${c}_dps`), mag: (n) => n.map((c) => `${c}_gauss`), ppg: (n) => n,
};
const DIGITS = { ppg: 0, acc: 0, gyro: 4, mag: 5 };
const RAW_KEEP_S = 60;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const round = (v, d) => (d ? Math.round(v * 10 ** d) / 10 ** d : v);

let debug = false;
let session = null;   // { name, label, startedUnixMs, app, registry }
let store = null;
let drive = null;
const devices = new Map();
const dropouts = [];
const raw = [];       // last 60 s of packets, all sensors, for the debug bundle
const logs = [];
let marks = 0;
let flushTimer = 0, manifestTimer = 0;
setInterval(sendDisplay, 100); // live view works before and after recording too

const post = (m, transfer) => self.postMessage(m, transfer || []);
function log(level, msg) { logs.push({ t: Date.now(), level, msg }); if (logs.length > 1000) logs.splice(0, 200); if (level !== 'debug') post({ type: 'log', level, msg }); }

function device(id) {
  let d = devices.get(id);
  if (!d) {
    d = { id, athlete: 'unassigned', athleteId: null, position: null, mode: 'polar', kind: 'polar', bleName: null, streams: {}, cfg: {}, offsets: [], offset: null,
      hr: { i: 0, last: null, lastRx: null }, ppi: { recent: [] }, battery: [], events: [], link: null, frameNo: 0, clocks: {}, power: null };
    devices.set(id, d);
  }
  return d;
}
const base = (d) => `${d.id}_${safeName(d.athlete, 'unassigned')}`;

function stream(d, key) {
  let s = d.streams[key];
  if (!s) {
    s = { key, i: 0, prevTs: new Map(), frames: 0, badFrames: 0, lostSamples: 0, frameTypes: new Set(), file: null, cols: null,
      rateWin: [], hz: null, arrWin: [], arrivalHz: null, lastRx: null, disp: { t: [], v: [], ch: 1 }, ooo: 0, lat: [], latAt: -1, lat50: null, lat95: null };
    d.streams[key] = s;
  }
  return s;
}

// ---------- session ----------
async function startSession(m) {
  if (store) throw new Error('A session is already running.');
  drive = m.drive || drive;
  session = { name: sessionName(m.label), label: m.label, startedUnixMs: m.startedUnixMs, app: m.app, registry: m.registry };
  store = await SessionStore.start({ name: session.name, drive, checkpointEveryS: m.checkpointS, onStatus: (st) => post({ type: 'storage', status: st }) });
  session.name = store.name;
  marks = 0; dropouts.length = 0;
  for (const d of devices.values()) Object.assign(d, { streams: {}, hr: { i: 0, last: d.hr.last, lastRx: null }, events: [], battery: [], frameNo: 0, framesOpen: null, offsets: [], offset: null, slew: null, clocks: {} }); // session time restarts at 0
  await store.setManifest(manifest());
  clearInterval(flushTimer); clearInterval(manifestTimer);
  flushTimer = setInterval(() => { try { store?.flush(); } catch (e) { log('error', e.message); } }, 1000);
  manifestTimer = setInterval(() => store?.setManifest(manifest()).catch((e) => log('error', e.message)), 30000);
  post({ type: 'session', name: session.name });
}

async function endSession() {
  if (!store) return { drive: false, reason: 'No session running' };
  clearInterval(flushTimer); clearInterval(manifestTimer);
  for (const d of devices.values()) if (d.link?.lostAt != null) closeLinkGap(d, d.link.lostAt, null);
  session.endedUnixMs = Date.now();
  for (const d of devices.values()) { d.offsets = []; d.offset = null; d.slew = null; d.clocks = {}; } // app time resumes after the session
  const res = await store.finalize(manifest());
  const summary = { name: session.name, durationS: (session.endedUnixMs - session.startedUnixMs) / 1000, sensors: devices.size, marks, bytes: store.status.bytes, ...res };
  store = null; session = null;
  return summary;
}

function manifest() {
  const s = session;
  return {
    format: 'titanx-capture/1',
    app: s.app,
    session: {
      name: s.name, label: s.label,
      started: new Date(s.startedUnixMs).toISOString(), started_unix_ms: s.startedUnixMs,
      ended: s.endedUnixMs ? new Date(s.endedUnixMs).toISOString() : null,
      duration_s: s.endedUnixMs ? (s.endedUnixMs - s.startedUnixMs) / 1000 : null,
      clock: 't_session_s: seconds since the session started, on this laptop\'s monotonic clock. started_unix_ms is the wall clock at t_session_s = 0. t_sensor_ns: the sensor\'s own clock, ns since 2000-01-01.',
      sample_timing: 't_session_s of a sample = its sensor time + a per sensor offset that follows the smallest (receive time - sensor time) over the last 30 s, moving at most 10 ms per second so time never runs backwards in a stream. frames.csv (Polar) and rx_session_s (SensWear) keep every receive time.',
      gaps: 'Never interpolated. Every gap is listed under dropouts and left empty in the CSVs.',
    },
    devices: [...devices.values()].map((d) => ({
      device_id: d.id, kind: d.kind, ble_name: d.bleName || `Polar Sense ${d.id}`, athlete: d.athlete, athlete_id: d.athleteId, position: d.position, mode: d.mode,
      time_offset_s: d.offset, clock_offsets_s: d.kind === 'senswear' ? Object.fromEntries(Object.entries(d.clocks).map(([k, c]) => [k, c.offset])) : undefined,
      power: d.kind === 'senswear' ? d.power : undefined,
      streams: Object.fromEntries(Object.entries(d.streams).map(([k, st]) => [k, {
        file: st.file ? `${st.file}.csv` : null, requested: d.cfg[k]?.settings ?? null, factor: d.cfg[k]?.factor ?? null,
        frame_types: [...st.frameTypes], samples: st.i, frames: st.frames, bad_frames: st.badFrames,
        lost_samples_est: st.lostSamples, measured_hz: st.hz && round(st.hz, 3), arrival_hz: st.arrivalHz && round(st.arrivalHz, 3),
      }])),
      hr_samples: d.hr.i, battery: d.battery, events: d.events,
    })),
    dropouts,
    marks,
    registry: s.registry ?? null,
  };
}

// ---------- packets ----------
// The offset applied to a sensor clock may only move SLEW seconds per second towards the current
// estimate. A better estimate used to be applied at once, so a stream's session time could step back
// (up to 7 ms in v0.1.0 recordings). At 1 % the applied offset changes far less than one sample period
// between neighbouring samples, so session time always increases; a 100 ms first guess settles in 10 s.
const SLEW = 0.01;
function slewed(c, rx, target) {
  if (c.applied == null) { c.applied = target; c.at = rx; return target; }
  const max = SLEW * Math.max(0, rx - c.at);
  c.applied += Math.max(-max, Math.min(max, target - c.applied)); c.at = rx;
  return c.applied;
}

function offsetFor(d, rx, sensorS) {
  d.offsets.push([rx, rx - sensorS]);
  while (d.offsets.length && d.offsets[0][0] < rx - 30) d.offsets.shift();
  let best = Infinity; for (const [, o] of d.offsets) if (o < best) best = o;
  d.offset = slewed(d.slew ||= {}, rx, best);
  return d.offset;
}

function ensureFile(d, s, names) {
  const cols = s.key === 'ppi'
    ? ['i', 't_session_s', 't_sensor_ns', 'hr_bpm', 'pp_ms', 'pp_error_ms', 'blocker', 'skin_contact', 'skin_contact_supported']
    : ['i', 't_session_s', 't_sensor_ns', ...(UNIT_COLS[s.key] || ((n) => n))(names)];
  if (s.file && s.cols === cols.join(',')) return s.file;
  s.file = s.file ? `${base(d)}_${s.key}_${s.frameTypes.size}` : `${base(d)}_${s.key}`; // layout changed mid session: new file
  s.cols = cols.join(',');
  return store.openStream(s.file, cols).then(() => s.file);
}

async function onPmd(d, bytes, rx) {
  let f;
  try { f = parseFrame(bytes); } catch (e) { log('warn', `${d.id}: unreadable frame ${hex(bytes)}: ${e.message}`); return; }
  const key = KEY[f.measType];
  if (!key) { log('warn', `${d.id}: frame of type ${MEASUREMENT_TYPE_NAME[f.measType] ?? f.measType} ignored`); return; }
  const s = stream(d, key), cfg = d.cfg[key] || {};
  const prev = s.prevTs.get(f.frameType) ?? 0n;
  if (prev !== 0n && f.timestampNs <= prev) s.ooo++;
  s.prevTs.set(f.frameType, f.timestampNs); // as the SDK does: even if decoding fails below
  s.frameTypes.add(f.frameType | (f.compressed ? 0x80 : 0));
  const nominal = s.hz || cfg.sampleRate || 0;
  let dec, gap = null;
  const tryDecode = (prevNs) => decodeFrame(bytes, { factor: cfg.factor ?? 1, sampleRateHz: nominal, prevTimestampNs: prevNs });
  try {
    dec = tryDecode(prev);
    if (prev !== 0n && key !== 'ppi' && nominal) {
      const each = Number(f.timestampNs - prev) / 1e9 / dec.count;
      if (each > 1.5 / nominal || each < 0.5 / nominal) {
        dec = tryDecode(0n);
        const missing = Math.max(0, Math.round((Number(dec.sampleTimestampsNs[0] - prev) / 1e9) * nominal) - 1);
        gap = { device_id: d.id, stream: key, kind: 'packets', at_session_s: round(rx, 3), from_sensor_ns: String(prev), to_sensor_ns: String(dec.sampleTimestampsNs[0]), missing_samples_est: missing };
        if (each < 0.5 / nominal) gap.note = 'sensor clock went backwards or jumped';
      }
    }
  } catch (e) {
    try { dec = tryDecode(0n); } catch (e2) {
      s.badFrames++;
      log('warn', `${d.id} ${key}: frame not decoded (${e2.message}). Raw: ${hex(bytes)}`);
      return;
    }
    log('warn', `${d.id} ${key}: re-timed a frame from its own timestamp (${e.message})`);
  }
  if (gap) { s.lostSamples += gap.missing_samples_est; dropouts.push(gap); post({ type: 'gap', id: d.id, stream: key, from: rx - gap.missing_samples_est / nominal, to: rx, missing: gap.missing_samples_est }); log('warn', `${d.id} ${key}: about ${gap.missing_samples_est} samples lost, gap logged`); }

  const lastS = Number(dec.timestampNs) / 1e9;
  const off = offsetFor(d, rx, lastS);
  delay(s, rx, rx - (lastS + off));
  if (store) await ensureFile(d, s, dec.channelNames);
  const n = dec.count, ch = dec.channels, first = s.i;
  let text = '';
  if (key === 'ppi') {
    for (let j = 0; j < n; j++) {
      const p = dec.ppi[j], ts = dec.sampleTimestampsNs[j];
      const ts2 = ts === 0n ? '' : String(ts), sess = ts === 0n ? rx : Number(ts) / 1e9 + off;
      text += `${s.i++},${sess.toFixed(4)},${ts2},${p.hr},${p.ppMs},${p.ppErrorMs},${p.blocker},${p.skinContact},${p.skinContactSupported}\n`;
      d.ppi.recent.push([sess, p.ppMs, p.blocker]);
      s.disp.t.push(sess); s.disp.v.push(p.ppMs); s.disp.ch = 1;
    }
    const cut = rx - 60; d.ppi.recent = d.ppi.recent.filter((r) => r[0] >= cut);
  } else {
    const dg = DIGITS[key] ?? 4;
    for (let j = 0; j < n; j++) {
      const ts = dec.sampleTimestampsNs[j], sess = Number(ts) / 1e9 + off;
      let row = `${s.i++},${sess.toFixed(4)},${ts}`;
      for (let c = 0; c < ch; c++) row += ',' + round(dec.values[j * ch + c], dg);
      text += row + '\n';
      s.disp.t.push(sess);
      for (let c = 0; c < ch; c++) s.disp.v.push(dec.values[j * ch + c]);
      s.disp.ch = ch;
    }
    rateUpdate(s, dec, prev, gap, rx);
  }
  s.frames++; s.lastRx = rx;
  if (!store) return;
  store.append(s.file, text, n);
  store.append(await framesFile(d), `${d.frameNo++},${key},0x${(f.frameType | (f.compressed ? 0x80 : 0)).toString(16)},${rx.toFixed(4)},${dec.timestampNs},${n},${first},${gap ? gap.missing_samples_est : ''}\n`, 1);
}

async function framesFile(d) {
  const name = `${base(d)}_frames`;
  d.framesOpen ||= store.openStream(name, ['frame', 'stream', 'frame_type', 'rx_session_s', 't_sensor_ns_last', 'samples', 'first_i', 'gap_missing_est']);
  await d.framesOpen;
  return name;
}

// Sampling rate from the sensor's own timestamps (frames after a gap excluded), and delivered rate
// from receive times. If they disagree by more than 5 % the decoder or the timing is wrong.
function rateUpdate(s, dec, prev, gap, rx) {
  if (prev !== 0n && !gap) {
    s.rateWin.push([rx, dec.count, Number(dec.timestampNs - prev) / 1e9]);
    while (s.rateWin.length && s.rateWin[0][0] < rx - 10) s.rateWin.shift();
    let n = 0, dt = 0; for (const [, c, t] of s.rateWin) { n += c; dt += t; }
    if (dt > 1) s.hz = n / dt;
  }
  s.arrWin.push([rx, dec.count]);
  while (s.arrWin.length && s.arrWin[0][0] < rx - 10) s.arrWin.shift();
  if (s.arrWin.length > 2) {
    const span = rx - s.arrWin[0][0];
    let n = 0; for (let k = 1; k < s.arrWin.length; k++) n += s.arrWin[k][1];
    if (span > 5) s.arrivalHz = n / span;
  }
  if (s.hz && s.arrivalHz && !s.rateWarned && s.lostSamples === 0 && Math.abs(s.arrivalHz - s.hz) / s.hz > 0.05 && s.arrWin.length > 20) {
    s.rateWarned = true;
    log('warn', `${s.key}: sensor timestamps say ${s.hz.toFixed(2)} Hz but samples arrive at ${s.arrivalHz.toFixed(2)} Hz`);
  }
}

async function onHr(d, bytes, rx) {
  let h;
  try { h = parseHeartRateMeasurement(bytes); } catch (e) { log('warn', `${d.id}: heart rate packet unreadable ${hex(bytes)}`); return; }
  d.hr.last = h.hr; d.hr.lastRx = rx;
  const s = stream(d, 'hr'); s.disp.t.push(rx); s.disp.v.push(h.hr); s.disp.ch = 1; s.lastRx = rx; s.frames++;
  if (!store) return;
  if (!s.file) { s.file = `${base(d)}_hr`; await store.openStream(s.file, ['i', 't_session_s', 'hr_bpm', 'sensor_contact', 'rr_ms']); }
  store.append(s.file, `${d.hr.i++},${rx.toFixed(4)},${h.hr},${h.sensorContact ? 1 : 0},${h.rrsMs.join(';')}\n`, 1);
  s.i = d.hr.i;
}

// ---------- SensWear ----------
// One sample per notification, each with its own board time stamp: PPG on a ms clock, IMU on a µs clock.
// Each clock gets its own session offset, found the same way as Polar's. Gaps are found from the time
// stamps (more than 1.5 sample periods apart), logged, and never filled in. Every row also keeps its
// receive time (rx_session_s), so the timing can be redone offline; there is no frames file.
const SW_STREAM = {
  ppg: { file: 'ppg_green', clock: 'ms', cols: ['counts'] }, ppg_red: { file: 'ppg_red', clock: 'ms', cols: ['counts'] }, ppg_ir: { file: 'ppg_ir', clock: 'ms', cols: ['counts'] },
  acc: { file: 'acc', clock: 'us', cols: ['x_mg', 'y_mg', 'z_mg'] }, gyro: { file: 'gyro', clock: 'us', cols: ['x_raw', 'y_raw', 'z_raw'] },
  quat: { file: 'quat', clock: 'us', cols: ['w', 'x', 'y', 'z', 'accuracy_rad'] },
};

function swOffset(d, clock, rx, sensorS) {
  const c = d.clocks[clock] ||= { offsets: [], offset: null };
  c.offsets.push([rx, rx - sensorS]);
  while (c.offsets.length && c.offsets[0][0] < rx - 30) c.offsets.shift();
  let best = Infinity; for (const [, o] of c.offsets) if (o < best) best = o;
  c.offset = slewed(c, rx, best);
  if (clock === 'ms') d.offset = c.offset;
  return c.offset;
}

async function swOpen(d, s, spec) {
  if (s.file) return;
  s.file = `${base(d)}_${spec.file}`;
  await store.openStream(s.file, ['i', 't_session_s', spec.clock === 'ms' ? 't_sensor_ms' : 't_sensor_us', 'rx_session_s', ...spec.cols]);
}

async function onSw(d, kind, bytes, rx) {
  if (kind === 'battery') { const v = SW.decodeBatteryLevel(bytes); d.battery.push({ t: round(rx, 1), pct: v }); return; }
  if (kind === 'power') {
    const p = SW.decodePowerStatus(bytes), txt = `power: battery ${p.batteryPresent ? 'present' : 'absent'}, wired ${SW.POWER_SOURCE[p.wiredPower]}, ${SW.CHARGE_STATE[p.chargeState]}${p.chargingFault ? `, charging fault ${p.chargingFault}` : ''}`;
    if (txt !== d.power?.text) { d.power = { t: round(rx, 1), text: txt, ...p }; d.events.push({ t: round(rx, 3), what: txt }); }
    return;
  }
  if (kind === 'temp') {
    const m = SW.decodeTemperature(bytes), s = stream(d, 'temp');
    s.disp.t.push(rx); s.disp.v.push(m.celsius); s.disp.ch = 1; s.lastRx = rx; s.frames++;
    if (!store) return;
    if (!s.file) { s.file = `${base(d)}_temperature`; await store.openStream(s.file, ['i', 'rx_session_s', 'celsius', 'board_time']); }
    store.append(s.file, `${s.i++},${rx.toFixed(4)},${round(m.celsius, 3)},${m.time ? m.time.toISOString() : ''}\n`, 1);
    return;
  }
  if (kind === 'gesture' || kind === 'activity') {
    const e = kind === 'gesture' ? SW.decodeGesture(bytes) : SW.decodeActivity(bytes);
    d.events.push({ t: round(rx, 3), what: `${kind} ${JSON.stringify({ ...e, tUs: String(e.tUs) })}` });
    return;
  }
  const spec = SW_STREAM[kind];
  if (!spec) { log('warn', `${d.id}: SensWear packet kind ${kind} ignored`); return; }
  let tick, vals;
  if (spec.clock === 'ms') { const p = SW.decodePpg(bytes); tick = p.tMs; vals = [p.value]; if (p.value > SW.PPG_ADC_MAX) log('warn', `${d.id} ${kind}: ${p.value} counts is above the 18 bit range`); }
  else if (kind === 'quat') { const q = SW.decodeQuaternion(bytes); tick = q.tUs; vals = [q.w, q.x, q.y, q.z, q.accuracyRad]; }
  else { const v = SW.decodeVector(bytes); tick = v.tUs; vals = kind === 'acc' ? [v.x, v.y, v.z].map((x) => (x * 1000) / SW.ACC_LSB_PER_G) : [v.x, v.y, v.z]; }
  const sensorS = Number(tick) / (spec.clock === 'ms' ? 1e3 : 1e6);
  const s = stream(d, kind), nominal = s.hz || d.cfg[kind]?.sampleRate || 0;
  const off = swOffset(d, spec.clock, rx, sensorS), sess = sensorS + off;
  delay(s, rx, rx - sess);
  if (s.prevS != null && nominal) {
    const dt = sensorS - s.prevS;
    if (dt > 1.5 / nominal) {
      const missing = Math.max(0, Math.round(dt * nominal) - 1);
      s.lostSamples += missing;
      dropouts.push({ device_id: d.id, stream: kind, kind: 'packets', at_session_s: round(rx, 3), from_sensor: String(s.prevTick), to_sensor: String(tick), missing_samples_est: missing });
      post({ type: 'gap', id: d.id, stream: kind, from: sess - dt, to: sess, missing });
    } else if (dt <= 0) { s.ooo++; log('warn', `${d.id} ${kind}: board time stamp went backwards or repeated (${s.prevTick} then ${tick})`); }
    else s.rateWin.push([rx, 1, dt]);
  }
  while (s.rateWin.length && s.rateWin[0][0] < rx - 10) s.rateWin.shift();
  if (s.rateWin.length > 20) { let n = 0, dt = 0; for (const [, c, t] of s.rateWin) { n += c; dt += t; } s.hz = n / dt; }
  s.arrWin.push([rx, 1]); while (s.arrWin.length && s.arrWin[0][0] < rx - 10) s.arrWin.shift();
  if (s.arrWin.length > 20) { const span = rx - s.arrWin[0][0]; if (span > 5) s.arrivalHz = (s.arrWin.length - 1) / span; }
  s.prevS = sensorS; s.prevTick = tick; s.frames++; s.lastRx = rx;
  s.disp.t.push(sess); for (const v of kind === 'quat' ? vals.slice(0, 4) : vals) s.disp.v.push(v); s.disp.ch = kind === 'quat' ? 4 : vals.length;
  if (!store) { s.i++; return; }
  await swOpen(d, s, spec);
  store.append(s.file, `${s.i++},${sess.toFixed(4)},${tick},${rx.toFixed(4)},${vals.map((v) => (kind === 'quat' ? round(v, 6) : v)).join(',')}\n`, 1);
}

// Delay of each packet above the least delayed one (the offset is the smallest receive minus sensor
// time seen): how long the radio and the sensor's buffering held it. Median and 95th percentile over
// the last 10 s, worked out at most once a second.
function delay(s, rx, sec) {
  s.lat.push([rx, sec]);
  if (s.lat[0][0] < rx - 10) { let k = 0; while (k < s.lat.length && s.lat[k][0] < rx - 10) k++; s.lat.splice(0, k); }
  if (rx - s.latAt < 1) return;
  s.latAt = rx;
  const v = s.lat.map((x) => x[1]).sort((a, b) => a - b);
  s.lat50 = v[Math.floor(v.length / 2)]; s.lat95 = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
}

function rmssd(d) {
  const r = d.ppi.recent.filter((x) => !x[2]).map((x) => x[1]);
  if (r.length < 3) return null;
  let q = 0; for (let i = 1; i < r.length; i++) q += (r[i] - r[i - 1]) ** 2;
  return Math.sqrt(q / (r.length - 1));
}

function sendDisplay() {
  for (const d of devices.values()) {
    const out = {}; const transfer = [];
    for (const [k, s] of Object.entries(d.streams)) {
      if (!s.disp.t.length) continue;
      const t = Float64Array.from(s.disp.t), v = Float32Array.from(s.disp.v);
      out[k] = { t, v, ch: s.disp.ch || 1 }; transfer.push(t.buffer, v.buffer);
      s.disp.t = []; s.disp.v = [];
    }
    const stats = Object.fromEntries(Object.entries(d.streams).map(([k, s]) => [k, { hz: s.hz, arrivalHz: s.arrivalHz, samples: s.i, frames: s.frames, lost: s.lostSamples, bad: s.badFrames, lastRx: s.lastRx, ooo: s.ooo, lat50: s.lat50, lat95: s.lat95 }]));
    post({ type: 'display', id: d.id, data: out, stats, hr: d.hr.last, hrRx: d.hr.lastRx, rmssd: rmssd(d), offset: d.offset }, transfer);
  }
}

// ---------- link events and marks ----------
function linkEvent(d, m) {
  const was = d.link?.state;
  d.link = { ...d.link, state: m.state };
  if (m.state === 'reconnecting' && was !== 'reconnecting') { d.link.lostAt = m.rx; d.events.push({ t: round(m.rx, 3), what: 'link lost' }); }
  if (m.state === 'streaming' && d.link.lostAt != null) { closeLinkGap(d, d.link.lostAt, m.rx); d.link.lostAt = null; d.events.push({ t: round(m.rx, 3), what: 'streaming again' }); }
  if (m.state === 'streaming' && was !== 'streaming') for (const s of Object.values(d.streams)) s.prevTs.clear(); // a restart begins new frame chains
  if (m.state === 'disconnected') d.events.push({ t: round(m.rx, 3), what: 'disconnected by the user' });
  if (m.state === 'failed') d.events.push({ t: round(m.rx, 3), what: `failed: ${m.error?.code || ''} ${m.error?.message || ''}` });
}
function closeLinkGap(d, from, to) {
  dropouts.push({ device_id: d.id, stream: null, kind: 'link', from_session_s: round(from, 3), to_session_s: to == null ? null : round(to, 3), duration_s: to == null ? null : round(to - from, 3) });
}

async function addMark(m) {
  const samples = {};
  for (const d of devices.values()) {
    if (m.target !== 'all' && d.athleteId !== m.target) continue;
    for (const [k, s] of Object.entries(d.streams)) samples[`${d.id}.${k}`] = s.i - 1;
  }
  const rec = { ...m, t_session_s: round(m.t, 4), newest_sample_index: samples, note: 'newest_sample_index: index of the newest sample of each targeted stream received when the button was pressed' };
  delete rec.t;
  marks++;
  if (store) await store.addAnnotation(rec);
  post({ type: 'mark-saved', mark: rec });
}

// ---------- debug bundle, download, recovery ----------
async function bundle() {
  const env = { ...session?.app, now: new Date().toISOString(), devices: [...devices.values()].map((d) => ({ id: d.id, athlete: d.athlete, mode: d.mode, link: d.link, streams: Object.keys(d.streams), offset: d.offset })) };
  const rawCsv = 'rx_session_s,device_id,kind,hex\n' + raw.map((r) => `${r.rx.toFixed(4)},${r.id},${r.kind},${r.hex}`).join('\n') + '\n';
  return { env, workerLog: logs.slice(-500), rawCsv, manifest: session ? manifest() : null };
}

async function download(name) {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(name);
  const entries = [];
  for await (const [file, h] of dir.entries()) {
    if (h.kind === 'file' && file !== 'state.json' && file !== 'annotations.jsonl') entries.push({ name: `${name}/${file}`, source: await h.getFile() });
  }
  return zipToBlob(entries);
}

// ---------- router ----------
// Messages are handled strictly one after another: two frames of a new stream must not both try to
// create its file, and rows must reach the file in the order they arrived.
let queue = Promise.resolve();
self.onmessage = (e) => { queue = queue.then(() => handle(e.data)); };

async function handle(m) {
  try {
    switch (m.type) {
      case 'init': debug = !!m.debug; drive = m.drive || null; break;
      case 'drive': drive = m.drive; store?.setDrive(m.drive); break;
      case 'session-start': await startSession(m); break;
      case 'session-end': post({ type: 'ended', summary: await endSession() }); break;
      case 'device': Object.assign(device(m.id), { athlete: m.athlete || 'unassigned', athleteId: m.athleteId ?? null, position: m.position ?? null, mode: m.mode || 'polar', kind: m.kind || 'polar', bleName: m.bleName || null }); store?.setManifest(manifest()); break;
      case 'stream': { const d = device(m.id); d.cfg[m.key] = m.cfg; d.mode = m.cfg.mode || d.mode; const s = d.streams[m.key]; if (s) s.prevTs.clear(); store?.setManifest(manifest()); break; }
      case 'link': linkEvent(device(m.id), m); store?.setManifest(manifest()); break;
      case 'packet': {
        const d = device(m.id), bytes = new Uint8Array(m.bytes);
        raw.push({ rx: m.rx, id: m.id, kind: m.kind, hex: hex(bytes) });
        while (raw.length && raw[0].rx < m.rx - RAW_KEEP_S) raw.shift();
        if (debug) console.log(m.id, m.kind, m.rx.toFixed(3), hex(bytes));
        if (d.kind === 'senswear') { try { await onSw(d, m.kind, bytes, m.rx); } catch (e) { stream(d, m.kind).badFrames++; log('warn', `${d.id} ${m.kind}: not decoded (${e.message}). Raw: ${hex(bytes)}`); } }
        else if (m.kind === 'pmd') await onPmd(d, bytes, m.rx);
        else if (m.kind === 'hr') await onHr(d, bytes, m.rx);
        else if (m.kind === 'battery') { const b = parseBatteryLevel(bytes); if (b.valid) d.battery.push({ t: round(m.rx, 1), pct: b.percent }); }
        break;
      }
      case 'mark': await addMark(m.mark); break;
      case 'bundle': post({ type: 'bundle', id: m.id, bundle: await bundle() }); break;
      case 'download': post({ type: 'download', id: m.id, name: m.name, blob: await download(m.name) }); break;
      case 'recover': {
        const out = [];
        for (const u of await unfinishedSessions()) if (u.name !== session?.name) out.push(await recoverSession(u.name, drive));
        post({ type: 'recovered', sessions: out });
        break;
      }
      default: log('warn', `unknown message ${m.type}`);
    }
  } catch (err) {
    log('error', `${m.type}: ${err.message}`);
    post({ type: 'error', about: m.type, id: m.id, message: err.message });
  }
}
