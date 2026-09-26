// Live view: one slot per sensor. 1 to 2 sensors get full panels with four trace lanes, 3 to 4 get
// panels with two lanes, 5 or more get compact tiles plus the session strip. Every panel and tile
// opens the full monitor.
import T from '../../strings/en.js';
import { S, slotIds, slotState, liveHr, zoneFor, infoOf, athleteName, positionOf, planTarget, now } from '../state.js';
import { STATUS, current } from '../../core/plans.js';
import { zoneText, planClock } from './plan.js';
import { ICO, headSVG, battHTML, zoneBadge, esc, el, setHTML, setText, $, $$, fmtMS } from '../ui.js';
import { drawLane, drawSpark, drawStrip } from '../draw.js';
import { connect, retry, reconnect } from '../links.js';

let root = null, cards = [], layout = '';
/** planCtx: { next(), stop() } for the plan bar. */
export function mountLive(container, openMonitor, planCtx) {
  root = container;
  root._plan = planCtx;
  root.innerHTML = `<div data-k="planbar"></div><div class="strip" id="stripWrap" hidden><div class="strip-h"><span>SESSION SO FAR · ZONE PER SENSOR · PINS ARE EVENTS</span><span class="legend"><span><i class="hatch"></i>No data, never filled in</span></span></div><canvas id="strip" aria-label="Session so far, heart rate zone per sensor"></canvas></div><div class="live" id="live"></div>`;
  root._open = openMonitor;
  rebuild();
}

const layoutFor = (n) => (n <= 1 ? 'n1' : n === 2 ? 'n2' : n <= 4 ? 'n4' : 'n7');

/** Rebuild slot cards when the set of sensors or their states change shape. */
export function rebuild() {
  if (!root) return;
  const ids = slotIds(), L = layoutFor(ids.length + (ids.length ? 0 : 1));
  const live = $('#live', root);
  live.className = `live ${L}`;
  live.dataset.count = String(ids.length);
  $('#stripWrap', root).hidden = L !== 'n7';
  layout = L;
  cards = ids.map((id) => card(id, L));
  live.replaceChildren(...cards.map((c) => c.el), addSlot());
  refresh(now());
}

function addSlot() {
  const b = el(`<button class="addslot">${ids0() ? '+ Connect another sensor' : '+ Connect a sensor'}</button>`);
  b.addEventListener('click', () => connect(null));
  return b;
}
const ids0 = () => slotIds().length;

function headerHTML(id, tile) {
  const pos = positionOf(id);
  const name = `<span class="nm">${esc(athleteName(id))}</span>${ICO.chev}<span class="open">Open full monitor</span>`;
  return `<header class="ap-h">
    ${tile ? `<div class="ap-name">${name}</div>` : `<button class="ap-name" data-open aria-label="Open full monitor for ${esc(athleteName(id))}">${name}</button>`}
    <div class="ap-meta"><span class="pos">${headSVG(pos ? [pos] : [], 22)}${pos ? T.positions[pos] : 'Position not set'}</span><span class="conn" data-k="conn"><i></i><span></span></span><span class="batt" data-k="batt"></span></div>
  </header>
  <div class="tbar" data-k="tbar" hidden></div>`;
}

function kpisHTML(tile) {
  const tag = tile ? 'div' : 'button';
  return `<div class="kpis">
    <${tag} class="kpi ours" ${tile ? '' : 'data-open'}><span class="kh">${ICO.heart('var(--z5)')}${T.hr.ours}</span><span class="kv"><span class="big num dash" data-k="ours">–</span><span class="u" data-k="oursU"></span></span><span class="zslot" data-k="oursZ"><span class="pend">${T.hr.oursPending}</span></span></${tag}>
    <${tag} class="kpi polar" ${tile ? '' : 'data-open'}><span class="kh">${ICO.heart('var(--polar)')}${T.hr.ref}</span><span class="kbox"><span class="big num" data-k="polar"></span><span class="u" data-k="polarU"></span></span><span class="zslot" data-k="polarZ"></span></${tag}>
    <${tag} class="kpi hrv" ${tile ? '' : 'data-open'}><span class="kh">${ICO.heartline}HRV</span><span class="ks">RMSSD</span><span class="kv"><span class="big num" data-k="hrv"></span><span class="u" data-k="hrvU"></span></span></${tag}>
  </div>`;
}

/** Overview lanes. ACC and GYRO show the size of the movement on all three axes (1 g means still). */
export function laneSpecs(e, n) {
  const d = e.data;
  const all = [
    { key: 'ppg', name: 'PPG', icon: 'ppg', auto: true, minSpan: 50, series: [{ buf: d.ppgf, ch: 0, color: 'ppg' }], empty: 'Waiting for PPG' },
    { key: 'acc', name: 'ACCELEROMETER', unit: 'g', icon: 'acc', range: [0, 3], ticks: [0, 1, 2], series: [{ buf: d.accMag, color: 'acc', lw: 1.2, map: (v) => v / 1000 }] },
    { key: 'gyro', name: 'GYROSCOPE', unit: 'deg/s', icon: 'gyro', range: [0, 500], ticks: [0, 250, 500], series: [{ buf: d.gyroMag, color: 'gyro', lw: 1.2 }] },
    { key: 'mag', name: 'MAGNETOMETER', unit: 'µT, x axis', icon: 'mag', range: [-70, 70], ticks: [-50, 0, 50], series: [{ buf: d.mag, ch: 0, color: 'mag', map: (v) => v * 100 }], empty: 'No magnetometer data' },
  ];
  return n === 'n4' ? all.slice(0, 2) : all;
}

function laneHTML(L, h) {
  return `<div class="lane"><div class="lane-h"><span class="ln" style="color:var(--${L.series[0].color})">${ICO[L.icon]}<span style="color:var(--text)">${L.name}${L.unit ? ` <span class="dim">· ${L.unit}</span>` : ''}</span></span><span class="lr"><b data-r="${L.key}">--</b><span class="sep"></span><span>Last packet <b data-a="${L.key}">--</b></span></span></div><canvas class="lane-c" style="--lh:${h}px"></canvas></div>`;
}

function card(id, L) {
  const tile = L === 'n7';
  const c = { id, tile, el: el(`<article class="${tile ? 'tile' : 'apanel'}" data-id="${id}" ${tile ? `tabindex="0" role="button" aria-label="Open full monitor for ${esc(athleteName(id))}"` : ''}></article>`) };
  c.el.innerHTML = headerHTML(id, tile) + `<div data-k="body"></div>`;
  if (tile) {
    c.el.addEventListener('click', (ev) => { if (!ev.target.closest('button')) root._open(id); });
    c.el.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === c.el) { ev.preventDefault(); root._open(id); } });
  } else $$('[data-open]', c.el).forEach((b) => b.addEventListener('click', () => root._open(id)));
  c.mode = null;
  return c;
}

/** Body of a card depends on the slot state: connect prompt, step log, or live data. */
function body(c, st) {
  const want = st === 'empty' ? 'empty' : st === 'connecting' || st === 'failed' ? 'steps' : 'live';
  if (c.mode === want) return;
  c.mode = want;
  const b = c.el.querySelector('[data-k="body"]');
  const e = S.links.get(c.id);
  if (want === 'empty') {
    b.className = 'slot-body';
    b.innerHTML = `<p class="hint">${ICO.info}<span>${T.connect.hint} This one is <b>${c.id.slice(-4)}</b>.</span></p><div><button class="btn primary" data-connect>${T.connect.button}</button></div>`;
    b.querySelector('[data-connect]').addEventListener('click', () => connect(c.id));
  } else if (want === 'steps') {
    b.className = 'slot-body';
    b.innerHTML = `<ol class="stepl" data-k="steps"></ol><div data-k="err"></div>`;
  } else {
    b.className = '';
    b.innerHTML = kpisHTML(c.tile) + (c.tile ? '<canvas class="spark" aria-hidden="true"></canvas>' : `<div class="lanes">${(c.lanes = laneSpecs(e, layout)).map((L) => laneHTML(L, layout === 'n4' ? 64 : 86)).join('')}</div>`);
    if (!c.tile) {
      const cs = $$('canvas.lane-c', b); c.lanes.forEach((L, i) => { L.c = cs[i]; });
      $$('[data-open]', b).forEach((x) => x.addEventListener('click', () => root._open(c.id)));
    } else c.spark = b.querySelector('.spark');
  }
}

function stepsHTML(e) {
  const t0 = e.linkState?.steps || [];
  return t0.map((s) => `<li class="${s.state}"><span class="s"></span><span>${T.connect.steps[s.name] || s.name}${s.attempts > 1 ? ` <span class="dim">(try ${s.attempts})</span>` : ''}</span><span class="t">${s.ms != null ? `+${(s.ms / 1000).toFixed(1)} s` : ''}</span></li>`).join('');
}

function errHTML(e) {
  const er = e.linkState?.error; if (!er || e.linkState.state !== 'failed') return '';
  const pair = er.code === 'streamRefused' ? T.errors.streamRefused(er.stream, er.meaning) : T.errors[er.code] || T.errors.unknown;
  return `<div class="err"><b>${esc(pair[0])}</b><span>${esc(pair[1])}</span></div><div style="margin-top:10px"><button class="btn primary" data-retry>${T.connect.retry}</button></div>`;
}

export function connText(e, st, t) {
  if (st === 'empty') return ['off', 'Not connected'];
  if (st === 'connecting' || st === 'starting') return ['warn', 'Connecting'];
  if (st === 'failed') return ['bad', 'Needs a retry'];
  if (st === 'reconnecting') return ['warn', `Reconnecting, attempt ${e.linkState.reconnectAttempt || 1}`];
  if (st === 'stale') { const last = Math.max(e.stats?.ppg?.lastRx ?? 0, e.stats?.acc?.lastRx ?? 0); return ['bad', `No data for ${Math.max(0, Math.floor(t - last))} s`]; }
  return ['', st === 'raw' ? 'Connected, max rate' : 'Connected'];
}

export function fillKpis(root2, e, st, t) {
  const hr = liveHr(e, t);
  if (S.pitch) {
    // Pitch screenshots only (?pitch=1 with simulated sensors): an illustrative number where our
    // algorithm's HR will go. Never shown with real sensors.
    const ours = hr != null ? Math.round(hr + 2.2 * Math.sin(t / 2.3 + e.id.charCodeAt(0))) : null;
    const o = root2.querySelector('[data-k="ours"]');
    if (o) {
      setText(o, ours != null ? String(ours) : '--'); o.classList.toggle('dash', ours == null);
      setText(root2.querySelector('[data-k="oursU"]'), ours != null ? 'bpm' : '');
      setHTML(root2.querySelector('[data-k="oursZ"]'), ours != null ? zoneBadge(zoneFor(e.id, ours)) : '');
    }
  }
  setText(root2.querySelector('[data-k="polar"]'), hr != null ? String(hr) : e.mode === 'max' ? 'Off' : st === 'ok' ? '--' : 'No data');
  root2.querySelector('[data-k="polar"]').classList.toggle('wordy', hr == null);
  setText(root2.querySelector('[data-k="polarU"]'), hr != null ? 'bpm' : '');
  const why = e.mode === 'max' ? 'Off in Max rate mode' : st === 'stale' || st === 'reconnecting' ? (e.hr != null ? `Last ${e.hr} bpm, not live` : 'Waiting for the sensor') : 'Arrives within 30 s of connecting';
  setHTML(root2.querySelector('[data-k="polarZ"]'), hr != null ? zoneBadge(zoneFor(e.id, hr)) : `<span class="pend">${why}</span>`);
  const hv = st === 'ok' && e.rmssd != null ? Math.round(e.rmssd) : null;
  setText(root2.querySelector('[data-k="hrv"]'), hv != null ? String(hv) : e.mode === 'max' ? 'Off' : '--');
  root2.querySelector('[data-k="hrv"]').classList.toggle('wordy', hv == null);
  setText(root2.querySelector('[data-k="hrvU"]'), hv != null ? 'ms' : '');
}

/** The running plan across the top of the live view. Rebuilt only when the phase changes, so its
 *  buttons stay the same elements (a click never lands on a replaced button); the countdown updates in place. */
function planBar(t) {
  const box = root.querySelector('[data-k="planbar"]'), ph = current(S.plan, t);
  const key = !S.plan ? '' : !ph ? `done:${S.plan.name}` : `${S.plan.name}:${ph.index}`;
  if (box._key !== key) {
    box._key = key;
    box.innerHTML = !S.plan ? ''
      : !ph ? `<div class="planbar"><b>${esc(S.plan.name)}</b><span>${T.plan.finished}</span><span class="spacer"></span><button class="btn" data-stop>${T.plan.stop}</button></div>`
      : `<div class="planbar" style="--zc:var(--z${ph.zone[1]})"><span class="eyebrow">PLAN</span><b>${esc(S.plan.name)}</b><span class="ph">${esc(ph.name)} <span class="dim">· phase ${ph.index + 1} of ${ph.count}</span></span>
         <span class="tgt">TARGET ${zoneText(ph.zone).toUpperCase()}</span><span class="left" data-k="left"></span>
         ${ph.next ? `<span class="dim">Next: ${esc(ph.next.name)}, ${zoneText(ph.next.zone).toLowerCase()}</span>` : ''}<span class="spacer"></span>
         <button class="btn" data-next>${T.plan.next}</button><button class="btn" data-stop>${T.plan.stop}</button></div>`;
    box.querySelector('[data-next]')?.addEventListener('click', () => root._plan?.next());
    box.querySelector('[data-stop]')?.addEventListener('click', () => root._plan?.stop());
  }
  if (ph) setText(box.querySelector('[data-k="left"]'), planClock(ph.left));
}

/** Status bar under a card header: work harder, on target or slow down against the plan's target. */
function targetBar(c, e, t) {
  const bar = c.el.querySelector('[data-k="tbar"]'), pt = S.plan && e ? planTarget(e, t) : null;
  if (!pt) { bar.hidden = true; delete c.el.dataset.status; return; }
  bar.hidden = false;
  if (!pt.status) { c.el.dataset.status = 'none'; setHTML(bar, `<span>${pt.why === 'noMax' ? T.plan.noMax : T.plan.noHr}</span><span class="dim">Target ${zoneText(pt.phase.zone).toLowerCase()}</span>`); bar.dataset.s = 'none'; return; }
  c.el.dataset.status = pt.status; bar.dataset.s = pt.status;
  const range = pt.bpm ? ` · ${pt.bpm[0]} to ${pt.bpm[1]} bpm` : '';
  const zNow = pt.zone === 0 ? 'below Z1' : `Z${pt.zone}`;
  setHTML(bar, `<b>${STATUS[pt.status].icon} ${T.plan.status[pt.status].toUpperCase()}</b><span>${c.tile ? `${zNow} now, target ${pt.phase.zone[0] === pt.phase.zone[1] ? `Z${pt.phase.zone[0]}` : `Z${pt.phase.zone[0]} to ${pt.phase.zone[1]}`}` : `Now ${pt.zone === 0 ? 'below zone 1' : `zone ${pt.zone}`} · target ${zoneText(pt.phase.zone).toLowerCase()}${range}`}</span>`);
}

/** 4 Hz: numbers, states, step logs, sparklines, strip. */
export function refresh(t) {
  if (!root) return;
  planBar(t);
  for (const c of cards) {
    const e = S.links.get(c.id), st = slotState(e, t);
    c.el.dataset.state = st;
    targetBar(c, e, t);
    body(c, st);
    const [cls, txt] = connText(e, st, t);
    const cn = c.el.querySelector('[data-k="conn"]'); cn.className = `conn ${cls}`; setText(cn.lastElementChild, txt);
    setHTML(c.el.querySelector('[data-k="batt"]'), battHTML(e?.linkState?.battery ?? null));
    if (c.mode === 'steps') {
      setHTML(c.el.querySelector('[data-k="steps"]'), stepsHTML(e));
      const errBox = c.el.querySelector('[data-k="err"]');
      const h = errHTML(e);
      if (errBox._h !== h) { errBox.innerHTML = h; errBox._h = h; errBox.querySelector('[data-retry]')?.addEventListener('click', () => retry(c.id)); }
    }
    if (c.mode === 'live') {
      fillKpis(c.el, e, st, t);
      if (c.tile) drawSpark(c.spark, e.data.hr, e.data.ppgf, e.mode === 'max', t);
      else for (const L of c.lanes) {
        const s = e.stats?.[L.key];
        setText(c.el.querySelector(`[data-r="${L.key}"]`), s?.hz ? `${s.hz.toFixed(1)} Hz` : '--');
        const a = c.el.querySelector(`[data-a="${L.key}"]`), age = s?.lastRx != null ? Math.max(0, t - s.lastRx) : null;
        setText(a, age != null ? `${age.toFixed(1)} s ago` : '--'); a.className = age > 3 ? 'bad' : '';
      }
    }
  }
  if (layout === 'n7') drawStrip($('#strip', root), cards.map((c) => { const e = S.links.get(c.id); return { label: `${athleteName(c.id).split(' ')[0]} · ${T.positions[positionOf(c.id)] || c.id.slice(-4)}`, hrBuf: e?.data.hr || { t: [], v: [] }, firstT: e?.data.firstT ?? null, maxMode: e?.mode === 'max', athleteId: infoOf(c.id).athlete?.id, zoneOf: (hr) => zoneFor(c.id, hr) }; }), S.marks, t);
}

/** Every frame: trace lanes of full panels. */
export function drawFrame(t) {
  if (!root || layout === 'n7') return;
  for (const c of cards) {
    if (c.mode !== 'live') continue;
    const pins = S.marks.filter((m) => m.target === 'all' || m.target === infoOf(c.id).athlete?.id);
    for (const L of c.lanes) drawLane(L.c, L, t, pins);
  }
}
export const unmountLive = () => { root = null; cards = []; };
export { fmtMS };
