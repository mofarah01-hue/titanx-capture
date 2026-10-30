// Titan X HR workbench page: session list, signal lanes, HR lanes per pipeline variant or model, and the
// comparison table. All data comes from server.py on 127.0.0.1; nothing is fetched from the network.
import { View, Lane, esc, tfmt } from './plot.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#3e9bff', '#f5a524', '#4cc38a', '#b388ff', '#2ec8c8', '#ff7ab6', '#c9d34a', '#ff8a4c', '#8fa8ff', '#e5484d'];
const ZONE_FILL = ['', '#7f8ea322', '#3e9bff22', '#4cc38a22', '#f5a52426', '#e5484d2e'];
const STAGES = [['fused_raw', 'Fused, before band-pass (4 s running mean removed for display)'], ['fused', 'Fused, band-passed'], ['nlms', 'After motion removal (NLMS)'], ['clean', 'After cadence notch = clean (beats on top: grey kept, red rejected)']];

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const status = (msg, bad) => { const s = $('status'); s.textContent = msg || ''; s.className = `small${bad ? ' bad' : ''}`; };

const S = { info: null, sessions: [], cur: null, dev: null, variants: [], fixed: [], stagesFrom: null, nextId: 1, busy: false, lastAuto: 0 };
const view = new View();

// ---------- variants ----------
function pipelineVariant(name, over = {}, ui = {}) {
  return { id: S.nextId++, kind: 'pipeline', name, color: PALETTE[(S.nextId - 2) % PALETTE.length], ui: { fusion: 'snr', bandpass: true, motion: 'acc+gyro', method: 'blend', notch: true, beats: true, tracker: true, gate: true, impact: true, viterbi: false, ...ui }, advanced: JSON.stringify(over, null, 1) === '{}' ? '' : JSON.stringify(over, null, 1), result: null };
}
function engineVariant(name, engine) { return { id: S.nextId++, kind: 'engine', engine, name, color: PALETTE[(S.nextId - 2) % PALETTE.length], result: null }; }

function configOf(v) {
  const u = v.ui;
  const c = {
    fusion: { method: u.fusion }, bandpass: { on: u.bandpass },
    nlms: u.motion === 'none' ? { on: false } : { on: true, refs: u.motion },
    estimate: { method: u.method }, notch: { on: u.notch }, beats: { on: u.beats }, tracker: { on: u.tracker },
    gate: { on: u.gate }, impact: { on: u.impact }, viterbi: { on: u.viterbi },
  };
  if (v.advanced.trim()) {
    const extra = JSON.parse(v.advanced);
    for (const [k, x] of Object.entries(extra)) c[k] = typeof x === 'object' && x ? { ...(c[k] || {}), ...x } : x;
  }
  return c;
}

function defaultVariants() {
  S.variants = [
    pipelineVariant('Pipeline (defaults)'),
    pipelineVariant('Pipeline, motion removal off', {}, { motion: 'none', notch: false }),
    engineVariant('iPad engine', 'ipad'),
  ];
  S.stagesFrom = S.variants[0].id;
}

const sel = (opts, val, key) => `<select data-k="${key}">${opts.map(([v, l]) => `<option value="${v}"${v === val ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const chk = (key, val, label) => `<label><input type="checkbox" data-k="${key}"${val ? ' checked' : ''}> ${label}</label>`;

function renderVariants() {
  const box = $('variants'); box.innerHTML = '';
  for (const v of S.variants) {
    const el = document.createElement('div'); el.className = 'card'; el.style.setProperty('--c', v.color);
    const r = v.result;
    const foot = v.status ? esc(v.status) : r ? `${r.answer.filter((a) => a.bpm != null).length} answers, ${r.ms} ms${r.run_id ? `, saved as run ${r.run_id}` : ''}` : 'not run';
    if (v.kind === 'pipeline') {
      const u = v.ui;
      el.innerHTML = `<div class="top"><input class="name" value="${esc(v.name)}"><label class="small" title="Show this variant's stage signals in the lanes below"><input type="radio" name="stages"${S.stagesFrom === v.id ? ' checked' : ''}> stages</label></div>
        <div class="grid">
          <span>Diode fusion</span>${sel([['snr', 'SNR-weighted (iPad)'], ['mean', 'Mean'], ['best', 'Best single channel']], u.fusion, 'fusion')}
          <span>Band-pass</span>${sel([['on', '0.5 to 4 Hz (iPad)'], ['off', 'off (wide 0.3 to 5 Hz)']], u.bandpass ? 'on' : 'off', 'bandpass')}
          <span>Motion removal</span>${sel([['none', 'None'], ['acc', 'NLMS, ACC'], ['acc+gyro', 'NLMS, ACC + GYRO (iPad)'], ['acc+gyro+mag', 'NLMS, ACC + GYRO + MAG']], u.motion, 'motion')}
          <span>HR method</span>${sel([['blend', 'Blend (iPad)'], ['spectral', 'Spectral only'], ['beats', 'Beat intervals only']], u.method, 'method')}
        </div>
        <div class="checks">${chk('notch', u.notch, 'cadence notch')}${chk('beats', u.beats, 'beat screening')}${chk('tracker', u.tracker, 'tracker')}${chk('gate', u.gate, 'confidence gate')}${chk('impact', u.impact, 'impact freeze')}${chk('viterbi', u.viterbi, 'Viterbi (offline)')}</div>
        <details${v.advanced ? ' open' : ''}><summary>more settings (JSON, merged over the above)</summary><textarea spellcheck="false" placeholder='{"nlms": {"mu": 0.05, "taps": 12}, "gate": {"min": 0.3}}'>${esc(v.advanced)}</textarea></details>
        <div class="foot"><button data-a="run">Run</button><button data-a="dup">Duplicate</button><button data-a="del">Remove</button><span>${foot}</span></div>`;
      el.querySelectorAll('[data-k]').forEach((x) => x.addEventListener('change', () => {
        const k = x.dataset.k;
        u[k] = x.type === 'checkbox' ? x.checked : k === 'bandpass' ? x.value === 'on' : x.value;
      }));
      el.querySelector('textarea').addEventListener('change', (e) => { v.advanced = e.target.value; });
      el.querySelector('input[type=radio]').addEventListener('change', () => { S.stagesFrom = v.id; buildLanes(); refresh(); });
    } else {
      el.innerHTML = `<div class="top"><input class="name" value="${esc(v.name)}"></div>
        <div class="grid"><span>Engine</span>${sel(engineOptions(), v.engine, 'engine')}</div>
        <div class="foot"><button data-a="run">Run</button><button data-a="del">Remove</button><span>${foot}</span></div>`;
      el.querySelector('[data-k=engine]').addEventListener('change', (e) => { v.engine = e.target.value; });
    }
    el.querySelector('input.name').addEventListener('change', (e) => { v.name = e.target.value; buildLanes(); refreshTable(); });
    el.querySelector('[data-a=run]').addEventListener('click', () => runVariant(v, true).then(afterRuns));
    el.querySelector('[data-a=del]').addEventListener('click', () => { S.variants = S.variants.filter((x) => x !== v); renderVariants(); buildLanes(); refresh(); refreshTable(); });
    el.querySelector('[data-a=dup]')?.addEventListener('click', () => {
      const c = pipelineVariant(`${v.name} (copy)`, {}, { ...v.ui }); c.advanced = v.advanced;
      S.variants.splice(S.variants.indexOf(v) + 1, 0, c); renderVariants(); buildLanes();
    });
    box.appendChild(el);
  }
}

function engineOptions() {
  const o = [['ipad', 'iPad engine (motionhr.js, live)'], ['ipad-viterbi', 'iPad engine + Viterbi (runOffline post)']];
  for (const m of S.info?.models || []) o.push([`model:${m.name}`, `${m.label}${m.available ? '' : ' (not installed)'}`]);
  return o;
}

function maxHr() { const m = +$('maxhr').value; if (m) return m; const a = +$('age').value; return a ? Math.round(208 - 0.7 * a) : null; }

async function runVariant(v, save) {
  if (!S.cur || !S.dev) return;
  const body = { id: S.cur.id, dev: S.dev, label: v.name, max_hr: maxHr(), save };
  if (v.kind === 'pipeline') { try { body.config = configOf(v); } catch (e) { v.status = `settings JSON: ${e.message}`; renderVariants(); return; } body.engine = 'pipeline'; }
  else if (v.engine.startsWith('model:')) { body.engine = 'model'; body.model = v.engine.slice(6); }
  else { body.engine = 'ipad'; body.viterbi = v.engine === 'ipad-viterbi'; }
  v.status = 'running...'; renderVariants();
  try { v.result = await api('/api/run', body); v.status = null; }
  catch (e) { v.status = `failed: ${e.message}`; }
  renderVariants();
}

async function runFixed() {
  S.fixed = [];
  const d = S.cur.devices.find((x) => x.base === S.dev);
  const want = [];
  if (S.cur.truth) want.push(['truth', 'Synthetic truth', '#ffffff']);
  if (d?.info?.hr) want.push(['polar', 'Polar HR (sensor)', '#e5484d']);
  for (const [engine, name, color] of want) {
    try { S.fixed.push({ name, color, engine, result: await api('/api/run', { id: S.cur.id, dev: S.dev, engine, max_hr: maxHr(), save: false }) }); }
    catch (e) { status(`${name}: ${e.message}`, true); }
  }
}

async function runAll(save = true) {
  if (S.busy) return; S.busy = true;
  try { await runFixed(); for (const v of S.variants) await runVariant(v, save); }
  finally { S.busy = false; }
  afterRuns();
}
function afterRuns() { buildLanes(); refresh(); refreshTable(); }

// ---------- lanes ----------
let lanes = [];
const marks = () => (S.cur?.annotations || []).map((a) => ({ t: a.t_session_s ?? a.t })).filter((m) => Number.isFinite(m.t));
function zones() {
  const m = maxHr(); if (!m) return null;
  const p = [0.5, 0.6, 0.7, 0.8, 0.9, 1.2];
  return [1, 2, 3, 4, 5].map((z) => ({ lo: p[z - 1] * m, hi: p[z] * m, color: ZONE_FILL[z], label: `Z${z}` }));
}
const hrLanes = () => [...S.fixed.map((f) => ({ name: f.name, color: f.color, result: f.result })), ...S.variants.filter((v) => v.result).map((v) => ({ name: v.name, color: v.color, result: v.result }))];

function buildLanes() {
  for (const l of lanes) l.remove();
  lanes = [];
  if (!S.cur) return;
  const box = $('lanes');
  const add = (o) => { const l = new Lane(box, view, { marks, ...o }); lanes.push(l); return l; };
  const allHr = add({ id: 'hr-all', title: 'All HR lanes (bpm), zone bands from max HR', height: 200, zones, minSpan: 40 });
  allHr.setSeries(hrLanes().map((h) => ({ name: h.name, color: h.color, kind: 'hr', data: h.result.answer, width: 1.6 })));
  add({ id: 'raw', title: 'Raw diodes: 3 greens and ambient, each scaled to its own range in view', height: 150, yFixed: [0, 4] });
  const src = S.variants.find((v) => v.id === S.stagesFrom && v.result?.key);
  for (const [name, title] of STAGES) add({ id: `st-${name}`, title: src ? `${title}  [${src.name}]` : `${title}  (run a pipeline variant to see it)`, height: 90, trace: name });
  add({ id: 'acc', title: 'ACC magnitude |a| (g)', height: 80 });
  add({ id: 'gyro', title: 'GYRO magnitude |w| (deg/s)', height: 80 });
  for (const h of hrLanes()) {
    const l = add({ id: `hr-${h.name}`, title: `${h.name} (bpm)`, height: 95, zones, minSpan: 40 });
    l.setSeries([{ name: '', color: h.color, kind: 'hr', data: h.result.answer, width: 1.6 }]);
  }
}
const lane = (id) => lanes.find((l) => l.o.id === id);

let refreshTimer = 0, refreshSeq = 0;
function refresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(doRefresh, 120); }
async function doRefresh() {
  if (!S.cur || !S.dev) return;
  const seq = ++refreshSeq, n = Math.max(300, Math.round(($('lanes').clientWidth || 1200)));
  const q = `id=${encodeURIComponent(S.cur.id)}&dev=${encodeURIComponent(S.dev)}&t0=${view.t0}&t1=${view.t1}&n=${n}`;
  try {
    const sig = await api(`/api/signals?${q}`);
    if (seq !== refreshSeq) return;
    if (sig.ppg) {
      const d = sig.ppg, ser = [];
      const cols = ['#4cc38a', '#2ec8c8', '#8fd14f', '#a0a0a0'];
      d.cols.forEach((c, k) => {
        const A = d.mode === 'env' ? d.min[k] : d.v[k], B = d.mode === 'env' ? d.max[k] : A;
        let lo = Infinity, hi = -Infinity; for (let i = 0; i < A.length; i++) { if (A[i] != null) { lo = Math.min(lo, A[i]); hi = Math.max(hi, B[i]); } }
        const sc = 0.85 / ((hi - lo) || 1);
        ser.push({ name: c, color: cols[k % cols.length], kind: d.mode, data: d, ch: k, scale: sc, offset: (d.cols.length - 1 - k) + 0.07 - lo * sc });
      });
      lane('raw')?.setSeries(ser);
    }
    if (sig.accMag) lane('acc')?.setSeries([{ name: '', color: '#f5a524', kind: sig.accMag.mode, data: sig.accMag }]);
    if (sig.gyroMag) lane('gyro')?.setSeries([{ name: '', color: '#b388ff', kind: sig.gyroMag.mode, data: sig.gyroMag }]);
    const src = S.variants.find((v) => v.id === S.stagesFrom && v.result?.key);
    if (src) {
      for (const [name] of STAGES) {
        const tr = await api(`/api/trace?key=${src.result.key}&name=${name}&t0=${view.t0}&t1=${view.t1}&n=${n}`).catch((e) => { status(e.message, true); return null; });
        if (seq !== refreshSeq || !tr) return;
        const ser = [{ name: '', color: src.color, kind: tr.mode, data: tr }];
        if (name === 'clean') ser.push({ name: '', color: '#cfd6de', kind: 'beats', data: src.result.beats });
        lane(`st-${name}`)?.setSeries(ser);
      }
    }
  } catch (e) { status(e.message, true); }
}
view.on((what) => { if (what === 'range') refresh(); else cursorReadout(); });

function cursorReadout() {
  const t = view.cursor;
  if (t == null) { $('cursor').textContent = ''; return; }
  const parts = [tfmt(t)];
  for (const h of hrLanes()) {
    let best = null; for (const p of h.result.answer) if (Math.abs(p.t - t) <= 1 && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    parts.push(`${h.name}: ${best?.bpm != null ? best.bpm.toFixed(1) : '-'}`);
  }
  $('cursor').textContent = parts.join('  |  ');
}

// ---------- comparison table ----------
let tableTimer = 0;
function refreshTable() { clearTimeout(tableTimer); tableTimer = setTimeout(doTable, 200); }
async function doTable() {
  const L = hrLanes(); const box = $('table');
  if (!S.cur || L.length < 2) { box.innerHTML = '<p class="muted small">Needs at least two HR lanes.</p>'; return; }
  const span = S.cur.devices.find((d) => d.base === S.dev)?.info?.ppg;
  try {
    const r = await api('/api/compare', { id: S.cur.id, dev: S.dev, lanes: Object.fromEntries(L.map((h) => [h.name, h.result.answer.map((a) => ({ t: a.t, bpm: a.bpm }))])), span: span ? [span.t0, span.t1] : null, lo: +$('lo').value, hi: +$('hi').value });
    const lv = ['all', 'low', 'mid', 'high'];
    const cls = (m) => (m == null ? '' : m < 3 ? 'good' : m < 8 ? 'mid' : 'poor');
    const pc = (x) => (x == null ? '-' : `${(x * 100).toFixed(0)} %`);
    let h = `<table><tr><th rowspan="2">Lane A</th><th rowspan="2">Lane B</th>${lv.map((l) => `<th colspan="3">${l} motion (${r.seconds[l] || 0} s)</th>`).join('')}</tr><tr>${lv.map(() => '<th>MAD</th><th>within 5</th><th>coverage</th>').join('')}</tr>`;
    const pairs = new Map(); for (const p of r.pairs) { const k = `${p.a}\u0000${p.b}`; if (!pairs.has(k)) pairs.set(k, {}); pairs.get(k)[p.level] = p; }
    for (const [k, by] of pairs) {
      const [a, b] = k.split('\u0000');
      h += `<tr><td class="l">${esc(a)}</td><td class="l">${esc(b)}</td>${lv.map((l) => { const p = by[l]; return p ? `<td class="${cls(p.mad)}">${p.mad == null ? '-' : p.mad.toFixed(2)}</td><td>${pc(p.within5)}</td><td>${pc(p.coverage)}</td>` : '<td></td><td></td><td></td>'; }).join('')}</tr>`;
    }
    h += '</table><h3>Coverage of each lane (share of seconds with an answer)</h3><table><tr><th>Lane</th>' + lv.map((l) => `<th>${l}</th>`).join('') + '</tr>';
    const by = new Map(); for (const x of r.lanes) { if (!by.has(x.lane)) by.set(x.lane, {}); by.get(x.lane)[x.level] = x; }
    for (const [n, x] of by) h += `<tr><td class="l">${esc(n)}</td>${lv.map((l) => `<td>${pc(x[l]?.coverage)}</td>`).join('')}</tr>`;
    box.innerHTML = h + '</table>';
  } catch (e) { box.innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`; }
}

// ---------- sessions ----------
function renderSessions() {
  const ul = $('sessions'); ul.innerHTML = '';
  $('sess-count').textContent = `(${S.sessions.length})`;
  for (const s of S.sessions) {
    const li = document.createElement('li');
    if (S.cur?.id === s.id) li.className = 'on';
    const dur = s.duration_s != null ? ` · ${tfmt(s.duration_s)}` : '';
    li.innerHTML = `<div>${s.live ? '<span class="live">LIVE</span>' : s.ended ? '<span class="ended">live, ended</span>' : ''}${esc(s.name)}</div>
      <div class="src">${esc(s.source)}${dur}${s.synthetic ? ' · synthetic' : ''}${s.error ? ` · ${esc(s.error)}` : ''}</div>`;
    li.addEventListener('click', () => openSession(s.id));
    ul.appendChild(li);
  }
}

async function pollSessions() {
  try { S.sessions = (await api('/api/sessions')).sessions; renderSessions(); } catch (e) { status(`session list: ${e.message}`, true); }
}

async function openSession(id, keepView) {
  try {
    status('loading...');
    const s = (await api(`/api/session?id=${encodeURIComponent(id)}`)).session;
    const first = !S.cur || S.cur.id !== id;
    S.cur = s;
    $('title').textContent = s.name; $('live-badge').hidden = !s.live;
    const devSel = $('device');
    if (first) {
      devSel.innerHTML = s.devices.map((d) => `<option value="${esc(d.base)}">${esc(d.device_id)} ${esc(d.athlete)} ${d.mode ? `(${esc(d.mode)})` : ''}</option>`).join('');
      S.dev = s.devices[0]?.base || null;
    }
    $('dev-box').hidden = !s.devices.length;
    const d = s.devices.find((x) => x.base === S.dev);
    const info = d?.info || {};
    $('dev-info').textContent = Object.entries(info).map(([k, x]) => `${k} ${x.hz ? x.hz.toFixed(1) : '?'} Hz, ${x.rows} rows`).join(' · ');
    if (info.ppg) {
      view.setFull(info.ppg.t0, info.ppg.t1);
      if (!keepView) view.set(info.ppg.t0, info.ppg.t1, true);
    }
    renderSessions();
    if (first) { for (const v of S.variants) v.result = null; S.fixed = []; buildLanes(); status(''); refresh(); await runAll(true); }
    status('');
  } catch (e) { status(e.message, true); }
}

async function liveTick() {
  if (!S.cur?.live || S.busy) return;
  const before = view.full[1];
  await openSession(S.cur.id, true);
  const end = view.full[1];
  if ($('follow').checked && end > before) {
    const w = view.t1 - view.t0;
    if (view.t1 >= before - 0.5) view.set(Math.max(view.full[0], end - w), end, true);
  }
  refresh();
  if ($('autorun').checked && Date.now() - S.lastAuto > Math.max(3, +$('autorun-s').value) * 1000) {
    S.lastAuto = Date.now();
    await runAll(false);
  }
}

// ---------- start ----------
async function start() {
  try {
    S.info = await api('/api/status');
    const c = S.info.config;
    $('dirs').textContent = `live: ${c.live_dir} · recordings: ${c.rec_dirs.join('; ')} · db: ${c.db}`;
    $('models').innerHTML = S.info.models.map((m) => `<li>${m.available ? '&#10003;' : '&#10007;'} <b>${esc(m.label)}</b> <span class="muted">${esc(m.licence)}${m.available ? '' : ` - ${esc(m.why)}`}</span></li>`).join('');
  } catch (e) { status(`server: ${e.message}`, true); }
  defaultVariants(); renderVariants();
  $('add').addEventListener('click', () => { S.variants.push(pipelineVariant(`Variant ${S.nextId}`)); renderVariants(); });
  $('add-model').addEventListener('click', () => { const m = S.info?.models?.find((x) => x.available); S.variants.push(engineVariant(m ? m.label : 'iPad engine + Viterbi', m ? `model:${m.name}` : 'ipad-viterbi')); renderVariants(); });
  $('run-all').addEventListener('click', () => runAll(true));
  $('reset').addEventListener('click', () => view.reset());
  $('device').addEventListener('change', (e) => { S.dev = e.target.value; for (const v of S.variants) v.result = null; openSession(S.cur.id).then(() => runAll(true)); });
  for (const id of ['age', 'maxhr']) $(id).addEventListener('change', () => { $('zone-info').textContent = `max HR ${maxHr() ?? '-'} bpm`; buildLanes(); refresh(); });
  for (const id of ['lo', 'hi']) $(id).addEventListener('change', refreshTable);
  $('zone-info').textContent = `max HR ${maxHr()} bpm (Tanaka 208 - 0.7 x age). Zones 1 to 5 at 50/60/70/80/90 %.`;
  await pollSessions();
  setInterval(pollSessions, 2000);
  setInterval(liveTick, 1500);
  const want = new URLSearchParams(location.search).get('session');
  if (want) openSession(want);
}
start();
