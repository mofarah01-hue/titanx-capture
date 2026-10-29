// Titan X engineering page (engineering.html): link quality for one or two devices side by side, a
// Polar Verity Sense, a SensWear board, or one of each. Per device: link state and reconnects, RSSI
// where the browser gives it, notifications per second against expected, interval jitter and stalls
// (receive times, core/linkstats.js), and per stream the sensor clock rate, lost samples, gaps, out of
// order time stamps and packet delay (sensor time stamps, worked out by the capture worker). A live raw
// plot with a low-pass, high-pass or band-pass filter (core/algo/filters.js) under it.
// Nothing is recorded: no session is started, so the worker only decodes and counts.
// URL options: ?sim=1 offers two simulated Polar sensors and one simulated SensWear board.
import { SensorLink, chooseSensor } from '../core/ble/device.js';
import { SensWearLink, chooseSensWear } from '../core/senswear/link.js';
import { SimRadio } from '../core/sim/fake-sensor.js';
import { SimSensWearRadio } from '../core/sim/fake-senswear.js';
import { deviceIdFromName } from '../core/registry.js';
import { ArrivalStats } from '../core/linkstats.js';
import { lowpass, highpass, BandPass } from '../core/algo/filters.js';
import { VERSION, BUILT } from '../core/version.js';
import { Buf } from './state.js';
import { sensWearId } from './links.js';
import { readTokens, drawLane } from './draw.js';
import { esc, el, $, $$, toast, modal, setHTML, setText } from './ui.js';

const params = new URLSearchParams(location.search);
const SIM = params.get('sim') ? 1 : 0;
const MAX_SLOTS = 2;
const T0 = performance.now();
const now = () => (performance.now() - T0) / 1000;
const KIND_NAME = { polar: 'Polar Verity Sense', senswear: 'SensWear' };
// What each stream is called and what its channels are, for the plot picker.
const STREAM_CH = {
  ppg: { polar: ['PPG 0', 'PPG 1', 'PPG 2', 'Ambient'], senswear: ['Green'] }, ppg_red: ['Red'], ppg_ir: ['IR'],
  acc: ['X', 'Y', 'Z'], gyro: ['X', 'Y', 'Z'], mag: ['X', 'Y', 'Z'], quat: ['W', 'X', 'Y', 'Z'],
};
const chNames = (key, kind) => { const c = STREAM_CH[key]; return Array.isArray(c) ? c : c?.[kind] || ['0']; };
// Characteristics that notify now and then (status, battery, control point, events), not streams:
// counted, not rated. A stall is an interval with nothing on a stream: 1 s, or 2.5 s for Polar HR (1/s).
const OCCASIONAL = new Set(['battery', 'cp', 'power', 'temp', 'gesture', 'activity']);
const stallMsFor = (k) => (k === 'hr' ? 2500 : 1000);
const f1 = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

const slots = [];
let worker, polarRadio = null, swRadio = null, slotNo = 0;

boot();

function boot() {
  if (!SIM && !('bluetooth' in navigator)) {
    document.body.innerHTML = `<div class="gate"><div class="card"><span class="eyebrow">TITAN X ENGINEERING</span><h2>No Bluetooth here</h2><p>This browser has no Web Bluetooth. Open the page in Chrome or Edge on a PC or Mac, or from Pages in the Jabarin app on the iPad. Add ?sim=1 to the address to try it with simulated devices.</p></div></div>`;
    return;
  }
  if (SIM) {
    polarRadio = new SimRadio(2); swRadio = new SimSensWearRadio(1);
    polarRadio.onChooser = (list) => simChooser(polarRadio, list); swRadio.onChooser = (list) => simChooser(swRadio, list);
  }
  document.body.innerHTML = '';
  document.body.append(el(`<div class="app engx">
    <header class="top">
      <div class="brand"><span class="tx">TITAN X</span><span class="sep"></span><span class="sub">ENGINEERING · LINK QUALITY</span>${SIM ? '<span class="simtag">SIMULATED</span>' : ''}</div>
      <div></div>
      <div class="hright"><span class="dim" id="pick-l">Add a device</span>
        <button class="btn primary" data-add="polar">+ Polar Verity Sense</button>
        <button class="btn primary" data-add="senswear">+ SensWear</button></div>
    </header>
    <main id="main"><div class="engx-grid" id="slots"><div class="box engx-empty" id="empty"><h3>NO DEVICE CONNECTED</h3>
      <p>Add one or two devices above: a Polar Verity Sense, a SensWear board, or one of each. Each gets its own column.</p>
      <p class="dim">Nothing is recorded on this page. The capture page (index.html, senswear.html) works as before.</p></div></div></main>
  </div>`));
  document.body.append(el(`<div class="ver">v${VERSION} · built ${BUILT}</div>`));
  readTokens();
  worker = new Worker(new URL('../core/capture-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => toast(`The decoder stopped: ${e.message}. Reload the page.`, 8000);
  worker.postMessage({ type: 'init' });
  $$('[data-add]').forEach((b) => b.addEventListener('click', () => add(b.dataset.add)));
  setInterval(refresh, 250);
  requestAnimationFrame(frame);
}

// ---------- connecting ----------
async function add(kind) {
  if (slots.length >= MAX_SLOTS) { toast('Two devices at most. Remove one first.'); return; }
  let device;
  try {
    device = await (kind === 'polar' ? (polarRadio ? polarRadio.requestDevice() : chooseSensor()) : (swRadio ? swRadio.requestDevice() : chooseSensWear()));
  } catch (e) { if (e?.name !== 'NotFoundError' || /adapter|not available/i.test(e?.message || '')) toast(`No device: ${e?.message || e}`, 7000); return; }
  const id = kind === 'polar' ? deviceIdFromName(device.name) : sensWearId(device);
  if (!id) { toast(`${device.name || 'That device'} is not a Polar sensor.`); return; }
  if (slots.some((s) => s.id === id)) { toast(`${id} is already on this page.`); return; }
  start(kind, device, id);
}

function start(kind, device, id) {
  const s = {
    n: ++slotNo, kind, id, device, state: 'connecting', reconnects: 0, since: null, linkState: null,
    streams: {}, stats: {}, gaps: {}, arr: new Map(), data: {},
    plot: { key: null, ch: 0 }, filt: { type: 'band', lo: 0.5, hi: 4, fs: null, f: null, lastT: null, err: null }, fbuf: new Buf(20, 1),
  };
  s.link = new (kind === 'polar' ? SensorLink : SensWearLink)(device, {
    mode: 'polar',
    onPacket: (k, bytes, rxMs) => {
      let a = s.arr.get(k); if (!a) s.arr.set(k, (a = new ArrivalStats({ stallMs: stallMsFor(k) })));
      a.add(rxMs);
      worker.postMessage({ type: 'packet', id, kind: k, rx: (rxMs - T0) / 1000, bytes: bytes.buffer }, [bytes.buffer]);
    },
    onStream: (key, cfg) => { s.streams[key] = cfg; worker.postMessage({ type: 'stream', id, key, cfg }); },
    onState: (st) => {
      const was = s.state;
      s.linkState = st; s.state = st.state;
      if (st.state === 'reconnecting' && was !== 'reconnecting') s.reconnects++;
      if (st.state === 'streaming' && was !== 'streaming') s.since = now();
      if (st.state !== was) worker.postMessage({ type: 'link', id, state: st.state, rx: now(), error: st.error });
    },
  });
  worker.postMessage({ type: 'device', id, kind, mode: kind === 'polar' ? 'polar' : 'senswear', athlete: `eng-${s.n}`, bleName: device.name || null });
  slots.push(s);
  mountSlot(s);
  s.link.run().catch(() => { /* the card shows the error and a Retry button */ });
}

async function remove(s) {
  await s.link.disconnect().catch(() => {});
  slots.splice(slots.indexOf(s), 1);
  s.root.remove();
  $('#empty').hidden = slots.length > 0;
}

function simChooser(radio, list) {
  modal(`<h2>Pick a device</h2><p class="dim">Simulated devices. With a real one the browser shows this list.</p>
    <div class="choices">${list.map((d) => `<button class="choice" data-id="${d.id}"><b>${esc(d.name)}</b><span class="dim">${d.id}</span></button>`).join('') || '<p class="dim">Every simulated device is already connected.</p>'}</div>
    <div class="foot"><span class="spacer"></span><button class="btn" data-x>Cancel</button></div>`, (d, close) => {
    $$('[data-id]', d).forEach((b) => b.addEventListener('click', () => { close(); radio.choose(b.dataset.id); }));
    d.querySelector('[data-x]').addEventListener('click', () => { close(); radio.cancel(); });
  }).then((v) => { if (v === null) radio.cancel(); });
}

// ---------- worker ----------
function onWorker(ev) {
  const m = ev.data, s = slots.find((x) => x.id === m.id);
  if (m.type === 'log' && m.level === 'error') console.warn('worker:', m.msg);
  if (!s) return;
  if (m.type === 'gap') s.gaps[m.stream] = (s.gaps[m.stream] || 0) + 1;
  if (m.type !== 'display') return;
  s.stats = m.stats;
  for (const [k, d] of Object.entries(m.data)) {
    if (!STREAM_CH[k]) continue;
    (s.data[k] ||= new Buf(20, d.ch)).add(d.t, d.v, d.ch);
    if (k === s.plot.key) filterNew(s, d);
  }
  if (!s.plot.key) pickDefaultPlot(s);
}

function pickDefaultPlot(s) {
  const key = ['ppg', 'acc', 'gyro'].find((k) => s.data[k]) || Object.keys(s.data)[0];
  if (!key) return;
  s.plot.key = key; s.plot.ch = 0;
  fillPlotPicker(s); refilter(s);
}

// ---------- filter ----------
// The filter runs on the plotted channel only, sample by sample, at the measured rate. It restarts
// after a gap (a filter run across missing samples rings) and is rebuilt when a setting changes.
function makeFilter(s) {
  const f = s.filt, key = s.plot.key;
  f.f = null; f.err = null; f.lastT = null;
  const fs = s.stats?.[key]?.hz || s.streams[key]?.sampleRate || null;
  f.fs = fs;
  if (f.type === 'off' || !fs) return;
  try {
    f.f = f.type === 'low' ? lowpass(fs, f.hi) : f.type === 'high' ? highpass(fs, f.lo) : new BandPass(fs, f.lo, f.hi);
    if (f.type === 'band' && !(f.lo < f.hi)) throw new RangeError('the low corner must be below the high corner');
  } catch (e) { f.f = null; f.err = e.message; }
}

function filterNew(s, d) {
  const f = s.filt;
  if (f.type === 'off') return;
  if (!f.f && !f.err) makeFilter(s);
  if (!f.f) return;
  const out = new Float32Array(d.t.length), ch = d.ch, c = Math.min(s.plot.ch, ch - 1);
  for (let i = 0; i < d.t.length; i++) {
    if (f.lastT != null && d.t[i] - f.lastT > 1.5 / f.fs) f.f.reset();
    f.lastT = d.t[i];
    out[i] = f.f.step(d.v[i * ch + c]);
  }
  s.fbuf.add(d.t, out, 1);
}

function refilter(s) {
  s.fbuf.clear(); makeFilter(s);
  const b = s.data[s.plot.key];
  if (b && b.t.length && s.filt.f) filterNew(s, { t: b.t, v: b.v, ch: b.ch });
  showFilter(s);
}

function showFilter(s) {
  const f = s.filt, r = s.root;
  $('[data-f="lo"]', r).disabled = f.type === 'off' || f.type === 'low';
  $('[data-f="hi"]', r).disabled = f.type === 'off' || f.type === 'high';
  setText($('[data-k="fwhy"]', r), f.err ? `Filter not applied: ${f.err}.` : f.type === 'off' ? 'Filter off.'
    : f.fs ? `Second order Butterworth sections at ${f.fs.toFixed(1)} Hz (measured rate). Restarts after every gap.` : 'Waiting for the measured rate.');
}

// ---------- the card ----------
function mountSlot(s) {
  const sw = s.kind === 'senswear';
  s.root = el(`<section class="box engx-slot">
    <div class="engx-h"><h3>${esc(KIND_NAME[s.kind])} · ${esc(s.id)}</h3><span class="spacer"></span>
      ${sw ? '<label class="inline"><input type="checkbox" data-c="imu" checked> IMU on</label>' : `<label class="field inline">Mode<select data-c="mode"><option value="polar">Polar (55 / 52 Hz)</option><option value="max">Max rate (176 / 416 Hz)</option></select></label>`}
      <button class="btn quiet" data-a="retry" hidden>Retry</button><button class="btn quiet" data-a="remove">Remove</button></div>
    <table class="kv engx-kv" data-k="link"></table>
    <h4>NOTIFICATIONS · RECEIVE TIMES ON THIS DEVICE</h4>
    <div class="engx-scroll"><table class="health"><thead><tr><th>Characteristic</th><th>Packets/s</th><th>Expected</th><th>Interval</th><th>Jitter</th><th>p95</th><th>Max</th><th title="Intervals over 1 s (Polar HR 2.5 s) since connecting">Stalls</th><th>Since last</th></tr></thead><tbody data-k="notif"></tbody></table></div>
    <p class="dim" data-k="occ"></p>
    <p class="dim">Interval, jitter (standard deviation), p95 and max in ms over the last 10 s.${sw ? ' SensWear sends one sample per notification in bursts (PPG at the FIFO interrupt, IMU every drain period, 100 ms stock), so large jitter is expected; a shortfall against expected is the real finding.' : ' Polar packs many samples into each PMD notification, so there is no fixed expected packet rate.'}</p>
    <h4>STREAMS · SENSOR TIME STAMPS</h4>
    <div class="engx-scroll"><table class="health"><thead><tr><th>Stream</th><th>Expected Hz</th><th>Sensor clock</th><th>Arrival</th><th>Lost</th><th>Gaps</th><th title="Time stamps that went backwards or repeated">Out of order</th><th>Bad</th><th title="Packet delay above the least delayed packet, median / 95th percentile">Delay p50 / p95</th></tr></thead><tbody data-k="streams"></tbody></table></div>
    <p class="dim">No packet carries a sequence number${sw ? ' (SensWear stock firmware)' : ' (Polar PMD)'}, so lost samples and gaps come from the sensor's time stamps (more than 1.5 sample periods apart).${sw ? ' SensWear PPG time stamps are filled in at the nominal period per FIFO batch, so a sample lost inside the chip does not show as a gap.' : ''} Delay: how much longer than the quickest packet each one took to arrive, ms.</p>
    <h4>LIVE PLOT</h4>
    <div class="ctl"><label class="field inline">Stream<select data-p="key"></select></label><label class="field inline">Channel<select data-p="ch"></select></label></div>
    <div class="lanes">
      <div class="lane"><div class="lane-h"><span class="ln"><span>RAW</span></span><span class="lr" data-k="rawr"></span></div><canvas class="lane-c" style="--lh:110px"></canvas></div>
      <div class="lane"><div class="lane-h"><span class="ln"><span>FILTERED</span></span><span class="lr" data-k="filtr"></span></div><canvas class="lane-c" style="--lh:110px"></canvas></div>
    </div>
    <div class="ctl"><label class="field inline">Filter<select data-f="type"><option value="off">Off</option><option value="low">Low-pass</option><option value="high">High-pass</option><option value="band" selected>Band-pass</option></select></label>
      <label class="field inline">Low corner<input type="number" step="0.1" min="0.05" data-f="lo" value="0.5" style="width:76px"> Hz</label>
      <label class="field inline">High corner<input type="number" step="0.1" min="0.1" data-f="hi" value="4" style="width:76px"> Hz</label>
      <span class="dim" data-k="fwhy"></span></div>
  </section>`);
  $('#slots').append(s.root);
  $('#empty').hidden = true;
  const [cr, cf] = $$('canvas.lane-c', s.root);
  s.lanes = [
    { c: cr, spec: { auto: true, minSpan: 1e-6, win: 10, series: [{ buf: { t: [], v: [], ch: 1 }, ch: 0, color: 'ppg', lw: 1.2 }], empty: 'No data yet' } },
    { c: cf, spec: { auto: true, minSpan: 1e-6, win: 10, series: [{ buf: s.fbuf, ch: 0, color: 'ppg2', lw: 1.2 }], empty: 'Filter off or waiting for the measured rate' } },
  ];
  s.root.addEventListener('click', (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (a === 'remove') remove(s);
    if (a === 'retry') s.link.retry().catch(() => {});
  });
  s.root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.c === 'imu') s.link.setImu(t.checked).catch((e) => { toast(`IMU switch failed: ${e.message}`); t.checked = !t.checked; });
    if (t.dataset.c === 'mode') { s.link.setMode(t.value).catch((e) => toast(`Mode change failed: ${e.message}`)); s.plot.key = null; s.data = {}; }
    if (t.dataset.p === 'key') { s.plot.key = t.value; s.plot.ch = 0; fillPlotPicker(s); refilter(s); }
    if (t.dataset.p === 'ch') { s.plot.ch = Number(t.value); refilter(s); }
    if (t.dataset.f) { const f = s.filt; f.type = $('[data-f="type"]', s.root).value; f.lo = Number($('[data-f="lo"]', s.root).value); f.hi = Number($('[data-f="hi"]', s.root).value); refilter(s); }
  });
  showFilter(s);
}

function fillPlotPicker(s) {
  const r = s.root, keys = Object.keys(s.data);
  $('[data-p="key"]', r).innerHTML = keys.map((k) => `<option value="${k}" ${k === s.plot.key ? 'selected' : ''}>${k.replace('_', ' ').toUpperCase()}</option>`).join('');
  $('[data-p="ch"]', r).innerHTML = chNames(s.plot.key, s.kind).map((n, i) => `<option value="${i}" ${i === s.plot.ch ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

// ---------- numbers, 4 times a second ----------
function rssiText() {
  if (SIM) return 'Simulated device: no radio';
  return 'Not available: Web Bluetooth gives no RSSI for a connected device (on the iPad it needs the Jabarin bridge to read it)';
}

function refresh() {
  const t = now(), ms = performance.now();
  for (const s of slots) {
    const r = s.root, st = s.state, err = s.linkState?.error;
    $('[data-a="retry"]', r).hidden = st !== 'failed';
    setHTML($('[data-k="link"]', r), [
      ['Link', `<span class="engx-st ${st}">${esc(st)}</span>${err ? ` <span class="dim">${esc(err.code || '')} ${esc(err.message || '')}</span>` : ''}${st === 'reconnecting' ? ` <span class="dim">try ${s.linkState?.reconnectAttempt || 1}</span>` : ''}`],
      ['Streaming for', s.since != null && st === 'streaming' ? `${Math.floor(t - s.since)} s` : '—'],
      ['Reconnects', String(s.reconnects)],
      ['RSSI', esc(rssiText())],
      ['Name', esc(s.device.name || '—')],
    ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join(''));

    const notif = [...s.arr.entries()].filter(([k]) => !OCCASIONAL.has(k)).sort().map(([k, a]) => {
      const x = a.read(ms), exp = expectedPackets(s, k);
      const short = exp && x.rate != null && x.rate < exp * 0.95;
      return `<tr><td>${esc(k.replace('_', ' '))}</td><td class="${short ? 'bad' : ''}">${f1(x.rate)}</td><td>${exp ? f1(exp, 0) : '—'}</td><td>${f1(x.mean)}</td><td>${f1(x.jitter)}</td><td>${f1(x.p95)}</td><td>${f1(x.max, 0)}</td><td class="${x.stalls ? 'warn' : ''}">${x.stalls}</td><td class="${x.sinceLast > 3000 ? 'bad' : ''}">${x.sinceLast == null ? '—' : x.sinceLast > 3000 ? `${(x.sinceLast / 1000).toFixed(0)} s` : `${f1(x.sinceLast, 0)} ms`}</td></tr>`;
    });
    const occ = [...s.arr.entries()].filter(([k]) => OCCASIONAL.has(k)).sort().map(([k, a]) => `${k} ${a.total}`);
    setText($('[data-k="occ"]', r), occ.length ? `Occasional notifications so far: ${occ.join(', ')}.` : '');
    setHTML($('[data-k="notif"]', r), notif.join('') || '<tr><td colspan="9" class="dim">No notifications yet</td></tr>');

    const rows = Object.entries(s.stats || {}).filter(([k]) => STREAM_CH[k] || k === 'hr' || k === 'ppi' || k === 'temp').map(([k, x]) => {
      const exp = s.streams[k]?.sampleRate, lostPct = x.lost ? (100 * x.lost) / (x.samples + x.lost) : 0;
      const off = exp && x.hz ? Math.abs(x.hz - exp) / exp : 0;
      return `<tr><td>${esc(k.replace('_', ' ').toUpperCase())}</td><td>${exp ? f1(exp, 0) : '—'}</td><td class="${off > 0.05 ? 'bad' : off > 0.02 ? 'warn' : ''}">${f1(x.hz, 2)}</td><td>${f1(x.arrivalHz, 2)}</td>
        <td class="${lostPct > 1 ? 'bad' : x.lost ? 'warn' : ''}">${x.lost || 0}${x.lost ? ` (${lostPct.toFixed(2)}%)` : ''}</td><td>${s.gaps[k] || 0}</td><td class="${x.ooo ? 'warn' : ''}">${x.ooo ?? '—'}</td><td class="${x.bad ? 'bad' : ''}">${x.bad || 0}</td>
        <td>${x.lat50 == null ? '—' : `${f1(x.lat50 * 1000, 0)} / ${f1(x.lat95 * 1000, 0)}`}</td></tr>`;
    });
    setHTML($('[data-k="streams"]', r), rows.join('') || '<tr><td colspan="9" class="dim">No samples yet</td></tr>');

    const b = s.data[s.plot.key];
    setText($('[data-k="rawr"]', r), b?.t.length ? `${s.plot.key.toUpperCase()} ${chNames(s.plot.key, s.kind)[s.plot.ch] || ''}, ${f1(b.v[(b.t.length - 1) * b.ch + s.plot.ch], 1)}` : '');
    // The rate the filter was designed for drifts as the measurement settles: rebuild past 5 %.
    const hz = s.stats?.[s.plot.key]?.hz;
    if (s.filt.type !== 'off' && hz && (!s.filt.fs || Math.abs(hz - s.filt.fs) / s.filt.fs > 0.05)) refilter(s);
  }
}

/** SensWear: one sample per notification, so packets per second should equal the stream's rate. */
function expectedPackets(s, k) {
  if (s.kind === 'senswear') return s.streams[k]?.sampleRate || null;
  return k === 'hr' ? 1 : null;
}

// ---------- drawing ----------
function frame() {
  const t = now();
  for (const s of slots) {
    const b = s.data[s.plot.key];
    if (b) { const ser = s.lanes[0].spec.series[0]; ser.buf = b; ser.ch = s.plot.ch; }
    for (const L of s.lanes) if (L.c.offsetParent) drawLane(L.c, L.spec, t);
  }
  requestAnimationFrame(frame);
}
