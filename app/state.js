// App state and the derived facts the views show. Views read from here; the worker and the links
// write into it. Nothing here touches the DOM.
import { sensorInfo, maxHrOf, zoneOf, emptyRegistry } from '../core/registry.js';
import { current, targetStatus, zoneBpm } from '../core/plans.js';
import { createMotionHr, layoutFor, defaultConfig } from '../core/algo/motionhr.js';

export const bus = new EventTarget();
export const emit = (what) => bus.dispatchEvent(new CustomEvent('change', { detail: what }));

export const S = {
  kind: 'polar',                 // which GUI this page is: 'polar' (index.html) or 'senswear' (senswear.html)
  env: null, sim: 0, debug: false,
  folder: { handle: null, name: '', permission: 'none', shared: null },
  storage: null,                 // status from the recorder: { local, lastLocalWrite, drive, lastDriveWrite, driveError, bytes }
  live: null,                    // live copy to the PC: { state: 'ok'|'behind'|'error'|'stopped'|'ended', behind, sent, error }
  reg: emptyRegistry(), regSource: 'new',
  session: null,                 // { name, label, startPerf, startUnix }
  summary: null,                 // result of the last ended session
  links: new Map(),              // deviceId -> entry (see links.js)
  gaps: [],                      // link gaps for the timeline (main.js trackLinkGaps; reset when a session starts)
  marks: [],                     // this session: { t, label, text, target, who }
  plan: null,                    // running training plan (core/plans.js startRun), or null
  phases: [],                    // this session's plan phases for the timeline: { from, to, name, zone }
  view: 'home', monitorId: null, tlZoom: 'all',
  appT0: performance.now(),
  update: null, hiddenWhileRecording: false, bluetooth: true, wake: false, degraded: false,
  logs: [],
  mhr: defaultConfig(),          // Motion HR settings (Engineering > Motion HR), same for every sensor
};

/** Session time in seconds (app time before a session starts). */
export const now = () => (performance.now() - (S.session ? S.session.startPerf : S.appT0)) / 1000;
export const rxOf = (perfMs) => (perfMs - (S.session ? S.session.startPerf : S.appT0)) / 1000;

export function log(level, msg) { S.logs.push({ t: new Date().toISOString(), level, msg }); if (S.logs.length > 600) S.logs.splice(0, 100); }

/** Time ordered samples, `ch` values per sample, trimmed to the last `keepS` seconds (0 keeps all). */
export class Buf {
  constructor(keepS, ch = 1) { this.keepS = keepS; this.ch = ch; this.t = []; this.v = []; }
  add(t, v, ch) {
    this.ch = ch;
    for (let i = 0; i < t.length; i++) { this.t.push(t[i]); for (let c = 0; c < ch; c++) this.v.push(v[i * ch + c]); }
    if (this.keepS && this.t.length) {
      const cut = this.t[this.t.length - 1] - this.keepS;
      if (this.t[0] < cut - this.keepS * 0.2) { let k = 0; while (k < this.t.length && this.t[k] < cut) k++; this.t.splice(0, k); this.v.splice(0, k * this.ch); }
    }
  }
  clear() { this.t = []; this.v = []; }
  get last() { return this.t.length ? this.t[this.t.length - 1] : null; }
}

export function newData() {
  return {
    ppg: new Buf(20, 4), ppgf: new Buf(20, 4), acc: new Buf(20, 3), gyro: new Buf(20, 3), mag: new Buf(20, 3),
    accMag: new Buf(20, 1), gyroMag: new Buf(20, 1),   // |xyz|, what the overview lanes draw
    hr: new Buf(0, 1), ppi: new Buf(600, 1),
    firstT: null,                                       // session time of this sensor's first sample
    move: new Buf(0, 1),                                // whole session: mean ||a| - 1 g| per second, for the timeline
    // SensWear only: red and IR PPG (green is `ppg`), orientation, skin temperature
    ppg_red: new Buf(20, 1), ppg_redf: new Buf(20, 1), ppg_ir: new Buf(20, 1), ppg_irf: new Buf(20, 1),
    quat: new Buf(20, 4), temp: new Buf(0, 1),
    pcHr: new Buf(0, 1),                                // heart rate from our motion robust engine (core/algo/motionhr.js), gated
    pcConf: new Buf(0, 1),                              // its confidence 0..1, once a second
    ppgBp: new Buf(20, 1), clean: new Buf(20, 1),       // fused PPG before motion removal, and after (25 Hz)
    beats: new Buf(20, 1), beatsBad: new Buf(20, 1),    // beats it accepted, and beats it rejected (impact, off the rate)
    accG: new Buf(20, 1),                               // |a| in g on the same grid
    hrSpec: new Buf(0, 1),                              // bpm from the spectral peak, once a second (HR lab)
    hrBeats: new Buf(0, 1),                             // bpm from the beat intervals (median), once a second
    hrBlend: new Buf(0, 1),                             // bpm after blending both and the tracker, before the confidence gate
  };
}

function magnitudes(t, v, ch) {
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = Math.hypot(v[i * ch], v[i * ch + 1], v[i * ch + 2]);
  return out;
}

// PPG for display only: remove the slow baseline per channel and flip it so a pulse points up.
// The recorded CSV keeps the raw counts.
function filterPpg(e, t, v, ch, key = 'ppg') {
  const all = e.ppgFilters ||= {};
  const f = all[key] ||= { base: null, lastT: null };
  const out = new Float32Array(v.length);
  for (let i = 0; i < t.length; i++) {
    const dt = f.lastT == null ? 0 : Math.max(0, Math.min(1, t[i] - f.lastT));
    const a = 1 - Math.exp(-dt / 1.2);
    if (!f.base || dt > 1) f.base = Array.from({ length: ch }, (_, c) => v[i * ch + c]);
    for (let c = 0; c < ch; c++) { const x = v[i * ch + c]; f.base[c] += (x - f.base[c]) * a; out[i * ch + c] = -(x - f.base[c]); }
    f.lastT = t[i];
  }
  return out;
}

/** Worker 'display' message into the entry's buffers. */
export function ingest(e, m) {
  for (const [k, d] of Object.entries(m.data)) {
    const b = e.data[k]; if (!b) continue;
    if (d.t.length && (e.data.firstT == null || d.t[0] < e.data.firstT)) e.data.firstT = d.t[0];
    b.add(d.t, d.v, d.ch);
    if (k === 'ppg') e.data.ppgf.add(d.t, filterPpg(e, d.t, d.v, d.ch), d.ch);
    if (k === 'ppg_red' || k === 'ppg_ir') e.data[`${k}f`].add(d.t, filterPpg(e, d.t, d.v, d.ch, k), d.ch);
    if (k === 'gyro' && d.ch >= 3) e.data.gyroMag.add(d.t, magnitudes(d.t, d.v, d.ch), 1);
    if (k === 'acc' && d.ch >= 3) {
      const m = magnitudes(d.t, d.v, d.ch);
      e.data.accMag.add(d.t, m, 1);
      const mv = e.moveAcc ||= { sec: null, s: 0, n: 0 };
      for (let i = 0; i < m.length; i++) {
        const sec = Math.floor(d.t[i]);
        if (mv.sec !== null && sec !== mv.sec && mv.n) { e.data.move.add([mv.sec + 0.5], [mv.s / mv.n], 1); mv.s = 0; mv.n = 0; }
        mv.sec = sec; mv.s += Math.abs(m[i] / 1000 - 1); mv.n++;
      }
    }
  }
  e.stats = m.stats; e.hr = m.hr; e.hrRx = m.hrRx; e.rmssd = m.rmssd;
  mhrFeed(e, m.data);
}

// Our heart rate: every PPG channel, ACC, GYRO and MAG go through the motion robust engine. It is
// rebuilt when the PPG layout changes (Polar mode 1 channel shown as 4, Max mode, SensWear) or when
// the Motion HR settings change (resetMhr).
function mhrFeed(e, data) {
  const ppg = data.ppg;
  if (ppg && (!e.mhr || e.mhrCh !== ppg.ch)) {
    e.mhrCh = ppg.ch;
    const d = e.data;
    e.mhr = createMotionHr(S.mhr, layoutFor(e.kind, ppg.ch), {
      onSample: (t, x) => { d.ppgBp.add([t], [x.fused], 1); d.clean.add([t], [x.clean], 1); if (x.accG != null) d.accG.add([t], [x.accG], 1); },
      onBeat: (t, y, ok) => (ok ? d.beats : d.beatsBad).add([t], [y], 1),
      onEstimate: (r) => { e.mhrLast = r; d.pcConf.add([r.t], [r.conf], 1); if (r.spec != null) d.hrSpec.add([r.t], [r.spec], 1); if (r.peaks != null) d.hrBeats.add([r.t], [r.peaks], 1); if (r.tracked != null) d.hrBlend.add([r.t], [r.tracked], 1); if (r.bpm != null) { e.pcHr = { t: r.t, bpm: r.bpm, quality: r.conf }; d.pcHr.add([r.t], [r.bpm], 1); } },
    });
  }
  if (!e.mhr) return;
  for (const [k, x] of Object.entries(data)) e.mhr.push(k, x.t, x.v, x.ch);
  e.mhr.run();
}

/** New Motion HR settings: every sensor's engine starts again with them. */
export function resetMhr(cfg) {
  S.mhr = cfg;
  for (const e of S.links.values()) { e.mhr = null; e.mhrLast = null; }
}

/** Our PC side HR if it is fresh (the estimator reports about once a second). */
export function pcHr(e, t = now()) {
  return e?.pcHr && t - e.pcHr.t <= 5 ? e.pcHr : null;
}

export function infoOf(id) { return sensorInfo(S.reg, id); }
export function athleteName(id) { return infoOf(id).athlete?.name || `Sensor ${id.slice(-4)}`; }
export function positionOf(id) { return infoOf(id).sensor?.position || null; }
export function maxHrFor(id) { return maxHrOf(infoOf(id).athlete); }
export const zoneFor = (id, hr) => zoneOf(hr, maxHrFor(id));

/**
 * What a sensor slot is doing: empty (not connected), connecting, failed, reconnecting,
 * starting (connected, first data not in yet), stale (connected but data stopped), ok, raw (Max rate).
 */
export function slotState(e, t = now()) {
  const st = e?.linkState?.state;
  if (!e || !st || st === 'idle' || st === 'disconnected') return 'empty';
  if (st === 'connecting' || st === 'failed' || st === 'reconnecting') return st;
  const last = Math.max(e.stats?.ppg?.lastRx ?? -Infinity, e.stats?.acc?.lastRx ?? -Infinity);
  if (!Number.isFinite(last)) return t - (e.streamingSince ?? t) > 8 ? 'stale' : 'starting';
  if (t - last > 3) return 'stale';
  return e.mode === 'max' ? 'raw' : 'ok';
}

/** Polar HR if it is live (updates every 5 s with PPI on, so older than 12 s counts as not live). */
export function liveHr(e, t = now()) {
  if (!e || e.mode === 'max' || e.hr == null || e.hrRx == null) return null;
  return t - e.hrRx <= 12 ? e.hr : null;
}

/** Data health, not accuracy: measured rates against requested, lost samples, beat to beat data present. */
export function trustOf(e, t = now()) {
  const st = slotState(e, t);
  if (st !== 'ok' && st !== 'raw') return { level: 'None', cls: 'bad', why: 'No live data' };
  const issues = [], sw = e.kind === 'senswear';
  for (const k of sw ? ['ppg', 'ppg_red', 'ppg_ir', 'acc', 'gyro'] : ['ppg', 'acc', 'gyro', 'mag']) {
    const s = e.stats?.[k], cfg = e.streams?.[k];
    if (!s || !cfg?.sampleRate || !s.hz) continue;
    // a sensor clock the worker found wrong is timed from arrival (capture-worker arrivalClock): judge the arrival rate
    const hz = s.clockBad ? s.arrivalHz ?? s.hz : s.hz;
    const off = Math.abs(hz - cfg.sampleRate) / cfg.sampleRate, name = k.replace('_', ' ').toUpperCase();
    const said = sw ? `SensWear's SDK says ${cfg.sampleRate} Hz` : `${cfg.sampleRate} Hz was set`;
    if (off > 0.1) issues.push([2, `${name} runs at ${hz.toFixed(1)} Hz, ${said}`]);
    else if (off > 0.03) issues.push([1, `${name} runs at ${hz.toFixed(1)} Hz, ${said}`]);
    const lost = s.lost / ((s.samples + s.lost) || 1);
    if (lost > 0.03) issues.push([2, `${(lost * 100).toFixed(1)}% of ${k.toUpperCase()} lost`]);
    else if (lost > 0.005) issues.push([1, `${(lost * 100).toFixed(1)}% of ${k.toUpperCase()} lost`]);
  }
  if (e.mode === 'polar' && t - (e.streamingSince ?? t) > 45 && !(e.stats?.ppi?.samples > 0)) issues.push([1, 'No beat to beat data yet']);
  const worst = Math.max(0, ...issues.map((i) => i[0]));
  if (!worst) return { level: 'High', cls: 'ok', why: 'Rates on target, nothing lost' };
  const top = issues.find((i) => i[0] === worst);
  return worst === 1 ? { level: 'Medium', cls: 'warn', why: top[1] } : { level: 'Low', cls: 'bad', why: top[1] };
}

/** Where one athlete stands against the running plan's target, or null when no plan runs. */
export function planTarget(e, t = now()) {
  const ph = current(S.plan, t);
  if (!ph || !e) return null;
  const max = maxHrFor(e.id), hr = liveHr(e, t);
  const zone = max && hr != null ? zoneOf(hr, max) : null;
  return { phase: ph, zone, status: targetStatus(zone, ph.zone), bpm: zoneBpm(ph.zone, max), why: !max ? 'noMax' : hr == null ? 'noHr' : null };
}

/** Slots in the live view: every registered sensor, then connected sensors nobody registered. */
export function slotIds() {
  const ids = S.reg.sensors.map((s) => s.deviceId);
  for (const id of S.links.keys()) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Athletes present in this view, for the event target list. */
export function athletesInView() {
  const seen = new Map();
  for (const id of slotIds()) { const a = infoOf(id).athlete; if (a && !seen.has(a.id)) seen.set(a.id, a); }
  return [...seen.values()];
}
