// Past runs: open a recording (this device or the save folder), replay it through the same Motion HR
// engine the live page uses, and see the heart rate pipeline stage by stage on a scrollable time axis.
// Re-run after changing settings on the Motion HR tab; the previous pass stays beside it for comparison.
import { esc, $, $$, toast, setText, fmtMS, fmtClock, ZONE_NAMES } from '../ui.js';
import { drawLane, lowerBound } from '../draw.js';
import { listRuns, loadRun } from '../../core/runs.js';
import { runOffline, mergeConfig, STAGES } from '../../core/algo/motionhr.js';
import { zoneOf } from '../../core/registry.js';

let root = null, ctx = null, runs = [], cur = null, seq = 0, raf = 0;

// ---------- small helpers ----------
/** "Oct 29, 4:05 PM" (year added when it is not this year). */
export function fmtWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '--';
  const o = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleString('en-US', o);
}
export function fmtLen(s) {
  if (s == null || !Number.isFinite(s)) return '--';
  s = Math.round(s);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
const clockOf = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const KIND = { senswear: 'SensWear', polar: 'Polar' };
// A pause long enough for the browser to paint "processing…" before the engine blocks the page.
const paint = () => new Promise((r) => setTimeout(r, 50));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function mountRuns(container, c) {
  unmountRuns();
  root = container; ctx = c; cur = null;
  window.addEventListener('resize', queueDraw);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  showList();
}

export function unmountRuns() {
  seq++; cancelAnimationFrame(raf); raf = 0;   // a read or a pass still running is dropped when it finishes
  window.removeEventListener('resize', queueDraw);
  if (root) { root.removeEventListener('click', onClick); root.removeEventListener('change', onChange); root.removeEventListener('input', onInput); }
  root = null; cur = null; runs = [];
}

// ---------- the list ----------
async function showList() {
  const my = ++seq; cur = null;
  root.innerHTML = `<div class="page runs"><div class="eng-h"><h2>Past runs</h2><button class="btn quiet" data-a="refresh">Refresh</button><span class="dim" data-k="msg">Looking for recordings…</span></div><div class="box" data-k="list"></div></div>`;
  let r;
  try { r = await listRuns({ opfs: true, folder: ctx.folder?.() ?? null }); } catch (e) { r = []; r.errors = [e.message]; }
  if (my !== seq || !root) return;
  runs = r;
  setText($('[data-k="msg"]', root), `${r.length} recording${r.length === 1 ? '' : 's'}, newest first${ctx.folder?.() ? '' : '. No save folder is set, so only this device was searched'}.`);
  const where = (x) => (x.source === 'device' ? 'This device' : 'Save folder') + (x.also ? ' + save folder' : '');
  const rows = r.map((x, i) => `<tr>
    <td><b>${esc(x.label)}</b>${x.finished ? '' : ' <span class="chip warn">not closed</span>'}<div class="dim">${esc(x.name)}</div></td>
    <td>${esc(fmtWhen(x.started))}</td><td>${esc(fmtLen(x.durationS))}</td>
    <td>${x.devices.map((d) => `${esc(d.athlete)} <span class="dim">${KIND[d.kind] || esc(d.kind)}</span>`).join('<br>') || '<span class="dim">none</span>'}</td>
    <td>${where(x)}</td>
    <td><span class="runs-btns"><button class="btn quiet" data-a="send" data-i="${i}" ${ctx.upload ? '' : 'disabled'}>Send to PC</button><button class="btn" data-a="open" data-i="${i}">Open</button></span></td></tr>`).join('');
  $('[data-k="list"]', root).innerHTML = (r.length
    ? `<table class="health"><thead><tr><th>Run</th><th>Started</th><th>Length</th><th>Sensors</th><th>Where</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No recordings found. Record a session first; finished ones appear here and in the save folder.</p>')
    + (r.errors.length ? `<div class="warn">${r.errors.map((e) => `<p>${esc(e)}</p>`).join('')}</div>` : '');
}

async function sendRun(btn, run) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending…';
  try { await ctx.upload(run); toast(`Sent "${run.label}" to the PC.`); } catch (e) { toast(`Could not send "${run.label}": ${e.message}`, 9000); }
  btn.disabled = false; btn.textContent = label;
}

// ---------- one run ----------
const LANES = [
  ['AFTER BAND-PASS · FIRST PPG CHANNEL', '', 76],
  ['AFTER MOTION REMOVAL · BEATS', '<span style="color:var(--ours)">&#9679; kept</span><span style="color:var(--bad)">&#9679; rejected</span>', 92],
  ['MOVEMENT · |a| IN g', '<span style="color:var(--bad)">- - impact threshold</span>', 76],
  ['HEART RATE', '<span style="color:var(--ours)">&#9632; Titan X live</span><span style="color:var(--ppg)">&#9632; after the fact</span><span style="color:var(--polar)">- - Polar</span><span data-k="lgprev" style="color:var(--z2)" hidden>&#9632; previous pass</span>', 140],
  ['CONFIDENCE', '<span style="color:var(--warn)">- - minimum to show a number</span>', 76],
];

async function openRun(run) {
  seq++;
  cur = { run, devId: null, data: null, pass: null, prev: null, win: 120, end: 0, winS: 120, tMin: 0, tMax: 1, lanes: [] };
  const first = run.devices.find((d) => d.streams.includes('ppg')) || run.devices[0];
  root.innerHTML = `<div class="page runs">
    <div class="eng-h"><button class="btn quiet" data-a="back">All runs</button><h2>${esc(run.label)}</h2><span class="dim">${esc(fmtWhen(run.started))} · ${esc(fmtLen(run.durationS))}</span>
      <label class="field inline">Sensor<select data-k="dev">${run.devices.map((d) => `<option value="${esc(d.id)}" ${d === first ? 'selected' : ''}>${esc(d.athlete)} · ${KIND[d.kind] || esc(d.kind)} · ${esc(d.id)}</option>`).join('') || '<option>None</option>'}</select></label></div>
    <p class="dim" data-k="status"></p><div data-k="warns"></div>
    <div data-k="out" hidden>
      <div class="runs-top"><div class="box"><h3>SUMMARY</h3><table class="kv" data-k="sum"></table></div>
        <div class="box"><h3>TIME IN ZONES · AFTER THE FACT HR</h3><div data-k="zones"></div></div></div>
      <div class="box"><h3>STAGE BY STAGE</h3>
        <div class="ctl"><label class="field inline">Window<select data-k="win">${[[10, '10 s'], [30, '30 s'], [120, '2 min'], ['all', 'Whole run']].map(([v, n]) => `<option value="${v}" ${v === cur.win ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <input type="range" data-k="pos" min="0" max="1" step="0.5" aria-label="Position in the run"><span class="dim" data-k="posl"></span>
          <button class="btn" data-a="rerun">Re-run with current Motion HR settings</button></div>
        <div class="lanes">${LANES.map(([n, lg, h], i) => `<div class="lane"><div class="lane-h"><span class="ln"><span>${n}</span><span class="lg">${lg}</span></span><span class="lr" data-k="lr${i}"></span></div><canvas class="lane-c" style="--lh:${h}px"></canvas></div>`).join('')}</div>
      </div></div></div>`;
  if (!first) { status('This run has no sensors in its manifest.', 'bad'); return; }
  await loadDevice(first.id);
}

function status(msg, cls = 'dim') { const s = root && $('[data-k="status"]', root); if (s) { s.className = cls; s.textContent = msg; } }

async function loadDevice(id) {
  const my = ++seq;
  Object.assign(cur, { devId: id, data: null, pass: null, prev: null });
  $('[data-k="out"]', root).hidden = true; $('[data-k="warns"]', root).innerHTML = '';
  status('Reading the recording…');
  let data;
  try { data = await loadRun(cur.run, id); } catch (e) { if (my === seq) status(`Could not read this run: ${e.message}`, 'bad'); return; }
  if (my !== seq || !root) return;
  cur.data = data;
  $('[data-k="warns"]', root).innerHTML = data.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('');
  if (!data.streams.ppg) { status('This sensor has no PPG recording in this run, so there is nothing to process.', 'bad'); return; }
  await process();
}

/** Replay the loaded streams through the engine with the settings on the Motion HR tab now. */
async function process() {
  const my = ++seq;
  status('Processing… a long run takes several seconds and the page waits meanwhile.');
  await paint();
  if (my !== seq || !root) return;
  const cfg = mergeConfig(ctx.config?.());
  const t0 = performance.now();
  let res;
  try { res = runOffline(cur.data.streams, cur.data.kind, cfg); } catch (e) { status(`Processing failed: ${e.message}`, 'bad'); return; }
  if (!res.raw.t.length) { status('Not enough clean PPG to process: the engine needs a few seconds of continuous signal. Check the warnings above.', 'bad'); return; }
  if (cur.pass) cur.prev = cur.pass;
  cur.pass = { res, cfg, at: Date.now(), secs: (performance.now() - t0) / 1000 };
  cur.tMin = res.raw.t[0]; cur.tMax = Math.max(res.raw.t[res.raw.t.length - 1], cur.tMin + 1);
  cur.end = Math.max(cur.end, cur.tMin);
  cur.lanes = buildLanes();
  status(`Processed ${fmtLen(cur.tMax - cur.tMin)} of signal in ${cur.pass.secs.toFixed(1)} s with the Motion HR settings of ${clockOf(cur.pass.at)}.${cur.prev ? ' The previous pass is shown beside it.' : ''}`);
  $('[data-k="out"]', root).hidden = false;
  renderSummary();
  geom();
  queueDraw();
}

// ---------- summary ----------
function summarize(pass) {
  const { est, post } = pass.res, byT = new Map(post.map((p) => [p.t, p.bpm]));
  let ans = 0, diff = 0, nd = 0;
  for (const e of est) if (e.bpm != null) { ans++; const p = byT.get(e.t); if (p != null) { diff += Math.abs(e.bpm - p); nd++; } }
  const maxHr = ctx.maxHr?.(cur.devId) ?? null, zones = Array(6).fill(0);
  for (const p of post) { const z = zoneOf(p.bpm, maxHr); if (z != null) zones[z]++; }
  return {
    secs: est.length, answered: est.length ? ans / est.length : null, conf: mean(est.map((e) => e.conf)), impacts: est.length ? est[est.length - 1].impacts : 0,
    diff: nd ? diff / nd : null, off: STAGES.filter(([k]) => pass.cfg[k]?.on === false).map((s) => s[1]), zones, maxHr,
  };
}

function renderSummary() {
  const now = summarize(cur.pass), was = cur.prev ? summarize(cur.prev) : null;
  const rows = [
    ['Seconds analysed', (s) => fmtLen(s.secs)],
    ['Seconds with a heart rate shown', (s) => (s.answered == null ? '--' : `${Math.round(s.answered * 100)} %`)],
    ['Mean confidence, all seconds', (s) => (s.conf == null ? '--' : `${Math.round(s.conf * 100)} %`)],
    ['Impacts found', (s) => String(s.impacts)],
    ['Live vs after the fact, mean gap', (s) => (s.diff == null ? '--' : `${s.diff.toFixed(1)} bpm`)],
    ['Stages switched off', (s) => (s.off.length ? esc(s.off.join(', ')) : 'none')],
  ];
  const dr = cur.data.dropouts, links = dr.filter((d) => d.kind === 'link').length;
  const head = was ? `<tr><th></th><th>Now</th><th>Previous pass</th></tr>` : '';
  $('[data-k="sum"]', root).innerHTML = head + rows.map(([k, f]) => `<tr><th>${k}</th><td>${f(now)}</td>${was ? `<td class="dim">${f(was)}</td>` : ''}</tr>`).join('')
    + `<tr><th>Recording gaps</th><td>${links} link loss${links === 1 ? '' : 'es'}, ${dr.length - links} lost packet gap${dr.length - links === 1 ? '' : 's'}</td>${was ? '<td></td>' : ''}</tr>`
    + `<tr><th>Marks</th><td>${cur.data.marks.length}</td>${was ? '<td></td>' : ''}</tr>`;
  const total = now.zones.reduce((a, b) => a + b, 0);
  $('[data-k="zones"]', root).innerHTML = !now.maxHr
    ? '<p class="dim">No max HR is known for this athlete, so zones cannot be worked out. Add one, then open the run again.</p>'
    : `<div class="dim">Max HR ${now.maxHr} bpm</div>` + now.zones.map((n, z) => `<div class="zrow"><span>Z${z} <span class="dim">${ZONE_NAMES[z]}</span></span><span class="zbar"><i style="width:${total ? (n / total) * 100 : 0}%;background:var(--z${z})"></i></span><span class="zv">${fmtMS(n)} · ${total ? Math.round((n / total) * 100) : 0} %</span></div>`).join('');
}

// ---------- lanes ----------
/** drawLane specs for the current pass. Series that span the window (thresholds) are re-cut on every draw. */
function buildLanes() {
  const r = cur.pass.res, cfg = cur.pass.cfg, g = cfg.impact.g, est = r.est;
  const buf = (t, v) => ({ t, v, ch: 1 });
  const ok = buf([], []), bad = buf([], []);
  for (const [t, y, k] of r.beats) { const b = k ? ok : bad; b.t.push(t); b.v.push(y); }
  const postBuf = (p) => buf(p.res.post.map((x) => x.t), p.res.post.map((x) => x.bpm));
  const live = buf(est.map((e) => e.t), est.map((e) => (e.bpm == null ? NaN : e.bpm)));   // NaN = no number shown: a break in the line
  const conf = buf(est.map((e) => e.t), est.map((e) => e.conf));
  const post = postBuf(cur.pass), polar = cur.data.polarHr;
  let peak = 0; for (const v of r.accG.v) if (v > peak) peak = v;
  const thr = buf([0, 0], [g, g]), gate = buf([0, 0], [cfg.gate.min, cfg.gate.min]);
  const cut = (b) => (end, w) => { b.t[0] = end - w; b.t[1] = end; };
  const at = (b, end) => { const i = lowerBound(b.t, end + 1e-6) - 1; return i >= 0 && end - b.t[i] <= 3 ? b.v[i] : null; };
  const inView = (b, end, w) => lowerBound(b.t, end + 1e-6) - lowerBound(b.t, end - w);
  const hi = cfg.impact.on ? Math.max(g * 1.4, Math.min(peak * 1.05, g * 3)) : Math.max(1.5, Math.min(peak * 1.05, 10));
  const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));
  $('[data-k="lgprev"]', root).hidden = !cur.prev;
  return [
    { spec: { auto: true, minSpan: 0.5, series: [{ buf: buf(r.raw.t, r.raw.v), color: 'ppg', lw: 1.2 }], empty: 'No PPG in view' } },
    { spec: { auto: true, minSpan: 0.5, series: [{ buf: buf(r.clean.t, r.clean.v), color: 'ppg2', lw: 1.2 }, { buf: bad, color: 'bad', dots: true }, { buf: ok, color: 'ours', dots: true }], empty: 'No PPG in view' },
      read: (end, w) => `${inView(ok, end, w)} kept, ${inView(bad, end, w)} rejected in view` },
    { pins: true, spec: { range: [0, hi], ticks: cfg.impact.on ? [0, g] : [0, 1], series: [{ buf: buf(r.accG.t, r.accG.v), color: 'acc', lw: 1.2 }, ...(cfg.impact.on ? [{ buf: thr, color: 'bad', dash: true, lw: 1, gapS: Infinity }] : [])], empty: 'No motion data in this run' },
      before: cut(thr), read: (end, w) => { let m = 0; const t = r.accG.t, v = r.accG.v; for (let i = lowerBound(t, end - w); i < t.length && t[i] <= end; i++) if (v[i] > m) m = v[i]; return r.accG.t.length ? `peak ${m.toFixed(1)} g in view` : ''; } },
    { pins: true, spec: { range: [40, 210], ticks: [60, 120, 180], series: [
      ...(cur.prev ? [{ buf: postBuf(cur.prev), color: 'z2', lw: 1.2, gapS: 3 }] : []),
      ...(polar ? [{ buf: polar, color: 'polar', dash: true, lw: 1.6, gapS: 12 }] : []),
      { buf: post, color: 'ppg', lw: 2, gapS: 3 }, { buf: live, color: 'ours', lw: 1.5, gapS: 3 }], empty: 'No heart rate in view' },
      read: (end) => `at ${fmtMS(end)}: live ${num(at(live, end))} · after the fact ${num(at(post, end))}${polar ? ` · Polar ${num(at(polar, end))}` : ''} bpm` },
    { spec: { range: [0, 1], ticks: [0, 0.5, 1], series: [{ buf: conf, color: 'ours', lw: 1.5, gapS: 3 }, ...(cfg.gate.on ? [{ buf: gate, color: 'warn', dash: true, lw: 1, gapS: Infinity }] : [])], empty: 'No confidence in view' },
      before: cut(gate), read: (end) => { const c = at(conf, end); return c == null ? '' : `${Math.round(c * 100)} % at ${fmtMS(end)}`; } },
  ];
}

/** Window length, slider range and position after any change of window or run. */
function geom() {
  const span = cur.tMax - cur.tMin, all = cur.win === 'all' || cur.win >= span, w = all ? span : cur.win;
  cur.winS = w; cur.end = all ? cur.tMax : Math.min(cur.tMax, Math.max(cur.tMin + w, cur.end));
  const p = $('[data-k="pos"]', root);
  p.step = w <= 30 ? 0.5 : 1; p.min = cur.tMin + w; p.max = cur.tMax; p.disabled = all; p.value = cur.end;
}

function queueDraw() { if (!raf) raf = requestAnimationFrame(draw); }
function draw() {
  raf = 0;
  if (!root || !cur?.pass) return;
  const { end, winS, lanes, data } = cur, cs = $$('canvas.lane-c', root), clk = cur.tMax >= 3600 ? fmtClock : fmtMS;
  lanes.forEach((l, i) => {
    l.before?.(end, winS);
    l.spec.win = winS; l.spec._r = null;           // _r eases the range from frame to frame; here a jump is wanted
    if (cs[i]) drawLane(cs[i], l.spec, end, l.pins ? data.marks : []);
    setText($(`[data-k="lr${i}"]`, root), l.read ? l.read(end, winS) : '');
  });
  setText($('[data-k="posl"]', root), `${clk(end - winS)} to ${clk(end)} of ${clk(cur.tMax)}`);
}

// ---------- events ----------
function onClick(ev) {
  const b = ev.target.closest('button'); if (!b || !root) return;
  const a = b.dataset.a, run = runs[Number(b.dataset.i)];
  if (a === 'refresh' || a === 'back') showList();
  else if (a === 'open' && run) openRun(run);
  else if (a === 'send' && run) sendRun(b, run);
  else if (a === 'rerun' && cur?.data) process();
}
function onChange(ev) {
  const k = ev.target.dataset.k;
  if (k === 'dev' && cur) loadDevice(ev.target.value);
  else if (k === 'win' && cur?.pass) { cur.win = ev.target.value === 'all' ? 'all' : Number(ev.target.value); geom(); queueDraw(); }
}
function onInput(ev) {
  if (ev.target.dataset.k !== 'pos' || !cur?.pass) return;
  cur.end = Number(ev.target.value); queueDraw();   // drag: redraw once per frame, not once per event
}
