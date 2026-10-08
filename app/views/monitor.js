// Full monitor for one sensor: every stream, measured rates, lost data, connection steps, events.
import T from '../../strings/en.js';
import { S, slotState, liveHr, trustOf, infoOf, athleteName, positionOf, maxHrFor, now } from '../state.js';
import { ICO, headSVG, battHTML, esc, el, setHTML, setText, $, $$, fmtMS, eventColor } from '../ui.js';
import { drawLane } from '../draw.js';
import { connect, retry, reconnect, disconnect, setMode, nameSensor } from '../links.js';
import { fillKpis, connText } from './live.js';

let root = null, id = null, lanes = [];

const xyz = (c) => `<span style="color:var(--${c})">x</span><span style="color:var(--${c}2)">y</span><span style="color:var(--${c}3)">z</span>`;
function specs(e) {
  const d = e.data, g = (c) => (v) => v / 1000;
  if (e.kind === 'senswear') return [
    ...[['ppg', d.ppgf, 'GREEN', 'ppg'], ['ppg_red', d.ppg_redf, 'RED', 'ppg1'], ['ppg_ir', d.ppg_irf, 'IR', 'ppg2']].map(([key, buf, nm, color], i) => ({ key, name: `PPG ${nm}`, icon: 'ppg', auto: true, minSpan: 50, h: i ? 58 : 76, series: [{ buf, ch: 0, color }], empty: `No ${nm.toLowerCase()} PPG` })),
    { key: 'acc', name: 'ACC', unit: 'g, gravity included', legend: xyz('acc'), icon: 'acc', range: [-2.5, 2.5], ticks: [-2, 0, 2], series: [0, 1, 2].map((ch) => ({ buf: d.acc, ch, color: ['acc', 'acc2', 'acc3'][ch], lw: 1.1, map: g() })), empty: 'IMU off or not sending' },
    { key: 'gyro', name: 'GYRO', unit: 'raw counts, no scale given', legend: xyz('gyro'), icon: 'gyro', auto: true, minSpan: 200, series: [0, 1, 2].map((ch) => ({ buf: d.gyro, ch, color: ['gyro', 'gyro2', 'gyro3'][ch], lw: 1.1 })), empty: 'IMU off or not sending' },
    { key: 'quat', name: 'ORIENTATION', unit: 'quaternion w x y z', icon: 'mag', range: [-1.05, 1.05], ticks: [-1, 0, 1], series: [0, 1, 2, 3].map((ch) => ({ buf: d.quat, ch, color: ['mag', 'mag2', 'mag3', 'ppi'][ch], lw: 1.1 })), empty: 'IMU off or not sending' },
    { key: 'hr', name: 'PC HR · LAST 5 MIN', icon: 'heartline', win: 300, range: [50, 210], ticks: [100, 150, 200], h: 110, noRate: 'Our PC estimate; SensWear has no HR of its own', empty: 'No PC estimate yet', series: [{ buf: d.pcHr, color: 'z5', lw: 1.6, gapS: 5 }] },
  ];
  return [
    ...[0, 1, 2].map((ch) => ({ key: 'ppg', name: `PPG ${ch}`, icon: 'ppg', auto: true, minSpan: 50, h: ch ? 58 : 76, series: [{ buf: d.ppgf, ch, color: ['ppg', 'ppg1', 'ppg2'][ch] }] })),
    { key: 'ppg', name: 'AMBIENT', icon: 'ppg', auto: true, minSpan: 20, h: 52, series: [{ buf: d.ppgf, ch: 3, color: 'amb' }] },
    { key: 'acc', name: 'ACC', unit: 'g', legend: xyz('acc'), icon: 'acc', range: [-2.5, 2.5], ticks: [-2, 0, 2], series: [0, 1, 2].map((ch) => ({ buf: d.acc, ch, color: ['acc', 'acc2', 'acc3'][ch], lw: 1.1, map: g() })) },
    { key: 'gyro', name: 'GYRO', unit: 'deg/s', legend: xyz('gyro'), icon: 'gyro', auto: true, minSpan: 60, series: [0, 1, 2].map((ch) => ({ buf: d.gyro, ch, color: ['gyro', 'gyro2', 'gyro3'][ch], lw: 1.1 })) },
    { key: 'mag', name: 'MAG', unit: 'µT', legend: xyz('mag'), icon: 'mag', range: [-70, 70], ticks: [-50, 0, 50], series: [0, 1, 2].map((ch) => ({ buf: d.mag, ch, color: ['mag', 'mag2', 'mag3'][ch], lw: 1.2, map: (v) => v * 100 })), empty: 'No magnetometer data' },
    { key: 'hr', name: 'HEART RATE · LAST 5 MIN', icon: 'heartline', win: 300, range: [50, 210], ticks: [100, 150, 200], h: 110, noRate: 'Reference dashed, Titan X solid once added',
      empty: e.mode === 'max' ? 'Reference HR is off in Max rate mode. Titan X HR will draw here.' : 'No heart rate yet', series: [{ buf: d.hr, color: 'polar', dash: true, lw: 1.6, gapS: 12 }, { buf: d.pcHr, color: 'z5', lw: 1.6, gapS: 5 }] },
  ];
}

export function mountMonitor(container, sensorId, back) {
  root = container; id = sensorId;
  const e = S.links.get(id);
  const pos = positionOf(id), max = maxHrFor(id);
  root.innerHTML = `
    <div class="mon-h">
      <button class="back" data-back>${ICO.back}All athletes</button>
      <h2>${esc(athleteName(id))}</h2>
      <div class="ap-meta"><button class="linkbtn" data-rename style="text-decoration:none;color:var(--text)"><span class="pos">${headSVG(pos ? [pos] : [], 30)}${pos ? T.positions[pos] : 'Position not set'}</span></button><span class="conn" data-k="conn"><i></i><span></span></span><span class="batt" data-k="batt"></span></div>
      <span class="ids">${S.kind === 'senswear' ? `${esc(e?.device?.name || 'Sens Wear')} · ID ${id}` : `Polar Sense ${id} · sticker ${id.slice(-4)}`} · ${max ? `max HR ${max}` : 'max HR not set'}</span>
      ${S.kind === 'senswear' ? '<span class="mode"><span class="dim">Rates, LED currents and registers: Engineering tab</span></span>' : `<span class="mode" role="group" aria-label="Capture mode"><button data-m="polar">${T.modes.polar}</button><button data-m="max">${T.modes.max}</button></span>`}
    </div>
    <p class="dim" data-k="modeNote" style="margin:-4px 0 12px"></p>
    <div data-k="main"></div>`;
  root.querySelector('[data-back]').addEventListener('click', back);
  root.querySelector('[data-rename]').addEventListener('click', () => nameSensor(id).then(() => mountMonitor(root, id, back)));
  $$('[data-m]', root).forEach((b) => b.addEventListener('click', () => { const cur = S.links.get(id); if (cur && b.dataset.m !== cur.mode) setMode(id, b.dataset.m); }));
  root._mode = null;
  refreshMonitor(now());
  void e;
}

function mainHTML(e) {
  lanes = specs(e);
  return `<div class="mon-kpis">
      <div class="kpi ours"><span class="kh">${ICO.heart('var(--z5)')}${S.pitch ? T.hr.ours : T.hr.pc}</span><span class="kv"><span class="big num dash" data-k="ours">–</span><span class="u" data-k="oursU"></span></span><span class="zslot" data-k="oursZ"><span class="pend">${T.hr.oursPending}</span></span></div>
      <div class="kpi polar"><span class="kh">${ICO.heart('var(--polar)')}${T.hr.ref}</span><span class="kbox"><span class="big num" data-k="polar"></span><span class="u" data-k="polarU"></span></span><span class="zslot" data-k="polarZ"></span></div>
      <div class="kpi hrv"><span class="kh">${ICO.heartline}HRV</span><span class="ks">RMSSD, LAST 60 S</span><span class="kv"><span class="big num" data-k="hrv"></span><span class="u" data-k="hrvU"></span></span></div>
      <div class="kpi"><span class="kh" style="color:var(--ppi)">${ICO.pulse}<span style="color:var(--text)">${e.kind === 'senswear' ? 'SKIN TEMP' : 'PPI'}</span></span><span class="ks">${e.kind === 'senswear' ? 'MAX30208, LAST READING' : 'LAST BEAT TO BEAT'}</span><span class="kv"><span class="big num" data-k="ppi"></span><span class="u" data-k="ppiU"></span></span></div>
      <div class="kpi"><span class="kh">TRUST</span><span class="ks">DATA HEALTH</span><span class="kv"><span class="big num" data-k="trust" style="font-size:34px"></span></span><span class="pend" data-k="trustWhy"></span></div>
      <div class="kpi"><span class="kh">EVENTS</span><span class="ks">FOR THIS ATHLETE</span><span class="kv"><span class="big num" data-k="nmarks" style="font-size:34px"></span></span><span class="pend">${S.session ? 'This session' : 'No session running'}</span></div>
    </div>
    <div class="mon-grid">
      <div class="lanes">${lanes.map((L) => `<div class="lane"><div class="lane-h"><span class="ln" style="color:var(--${L.series[0].color})">${ICO[L.icon]}<span style="color:var(--text)">${L.name}${L.unit ? ` <span class="dim">· ${L.unit}</span>` : ''}</span>${L.legend ? `<span class="lg">${L.legend}</span>` : ''}</span><span class="lr">${L.noRate ? `<span>${L.noRate}</span>` : `<b data-r="${L.key}">--</b><span class="sep"></span><span>Last packet <b data-a="${L.key}">--</b></span>`}</span></div><canvas class="lane-c" style="--lh:${L.h || 80}px"></canvas></div>`).join('')}</div>
      <aside class="side">
        <div class="box"><h3>STREAMS · MEASURED, NOT ASSUMED</h3><table class="health"><thead><tr><th>Stream</th><th>${S.kind === 'senswear' ? 'Expected' : 'Set'}</th><th>Sensor clock</th><th>Arrival</th><th>Samples</th><th>Lost</th><th>Last</th></tr></thead><tbody data-k="health"></tbody></table></div>
        <div class="box"><h3>CONNECTION</h3><ol class="stepl" data-k="steps"></ol><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn" data-recon>${T.connect.reconnect}</button><button class="btn quiet" data-disc>${T.connect.disconnect}</button></div></div>
        <div class="box"><h3>EVENTS FOR ${esc(athleteName(id).toUpperCase())}</h3><ul class="mklist" data-k="mk"></ul></div>
      </aside>
    </div>`;
}

export function refreshMonitor(t) {
  if (!root) return;
  const e = S.links.get(id), st = slotState(e, t);
  const [cls, txt] = connText(e, st, t);
  const cn = root.querySelector('[data-k="conn"]'); cn.className = `conn ${cls}`; setText(cn.lastElementChild, txt);
  setHTML(root.querySelector('[data-k="batt"]'), battHTML(e?.linkState?.battery ?? null));
  $$('[data-m]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === (e?.mode || infoOf(id).sensor?.mode || 'polar'))));
  setText(root.querySelector('[data-k="modeNote"]'), S.kind === 'senswear' ? 'One sample per Bluetooth notification. Measured rates below come from the time stamps the board puts on each sample.' : (e?.mode || 'polar') === 'max' ? T.modes.maxNote : T.modes.polarNote);
  const main = root.querySelector('[data-k="main"]');
  const want = e ? 'data' : 'empty';
  if (root._mode !== want) {
    root._mode = want;
    if (want === 'empty') {
      main.innerHTML = `<div class="card"><h2>Not connected</h2><p>${T.connect.hint} This one is <b>${id.slice(-4)}</b>.</p><div><button class="btn primary big" data-connect>${T.connect.button}</button></div></div>`;
      main.querySelector('[data-connect]').addEventListener('click', () => connect(id));
    } else {
      main.innerHTML = mainHTML(e);
      const cs = $$('canvas.lane-c', main); lanes.forEach((L, i) => { L.c = cs[i]; });
      main.querySelector('[data-recon]').addEventListener('click', () => (e.linkState?.state === 'failed' ? retry(id) : reconnect(id)));
      main.querySelector('[data-disc]').addEventListener('click', () => disconnect(id));
    }
  }
  if (want === 'empty') return;
  fillKpis(main, e, st, t);
  if (e.kind === 'senswear') {
    const tp = e.data.temp, tv = tp.t.length ? tp.v[tp.v.length - 1] : null;
    setText(main.querySelector('[data-k="ppi"]'), tv != null ? tv.toFixed(1) : '--'); setText(main.querySelector('[data-k="ppiU"]'), tv != null ? '°C' : '');
  } else {
    const ppi = e.data.ppi, last = ppi.t.length ? ppi.v[ppi.v.length - 1] : null, ppiLive = last != null && t - ppi.last < 15;
    setText(main.querySelector('[data-k="ppi"]'), ppiLive ? String(Math.round(last)) : e.mode === 'max' ? 'Off' : '--');
    setText(main.querySelector('[data-k="ppiU"]'), ppiLive ? 'ms' : '');
  }
  const tr = trustOf(e, t), te = main.querySelector('[data-k="trust"]');
  setText(te, tr.level); te.className = `big num ${tr.cls}`; setText(main.querySelector('[data-k="trustWhy"]'), tr.why);
  const aid = infoOf(id).athlete?.id, mine = S.marks.filter((m) => m.target === 'all' || m.target === aid);
  setText(main.querySelector('[data-k="nmarks"]'), String(mine.length));
  setHTML(main.querySelector('[data-k="mk"]'), mine.slice().reverse().map((m) => `<li><span class="dim">${fmtMS(m.t)}</span><i style="--ec:var(--${eventColor(m.label)})"></i><span><b>${esc(m.label)}</b>${m.text ? ` · ${esc(m.text)}` : ''}${m.target === 'all' ? ' <span class="dim">· all</span>' : ''}</span></li>`).join('') || '<li class="dim">No events yet</li>');
  const rows = [];
  const NAMES = { ppg: e.kind === 'senswear' ? 'PPG green' : 'PPG ×4', ppg_red: 'PPG red', ppg_ir: 'PPG IR', acc: 'ACC', gyro: 'GYRO', mag: 'MAG', quat: 'QUAT', temp: 'TEMP', hr: 'HR', ppi: 'PPI' };
  for (const k of e.kind === 'senswear' ? ['ppg', 'ppg_red', 'ppg_ir', 'acc', 'gyro', 'quat', 'temp'] : ['ppg', 'acc', 'gyro', 'mag', 'hr', 'ppi']) {
    const s = e.stats?.[k], cfg = e.streams?.[k]; if (!s && !cfg) continue;
    const age = s?.lastRx != null ? t - s.lastRx : null;
    const lostPct = s ? s.lost / ((s.samples + s.lost) || 1) : 0;
    rows.push(`<tr><td>${NAMES[k]}</td><td>${cfg?.sampleRate ? `${cfg.sampleRate} Hz${cfg.settings?.nominal ? '*' : ''}` : k === 'hr' ? '1 s' : k === 'ppi' ? 'beats' : k === 'temp' ? 'interval' : '--'}</td>
      <td>${s?.hz ? `${s.hz.toFixed(2)} Hz` : '--'}</td><td>${s?.arrivalHz ? `${s.arrivalHz.toFixed(2)} Hz` : '--'}</td><td>${(s?.samples ?? 0).toLocaleString('en-GB')}</td>
      <td class="${lostPct > 0.03 ? 'bad' : lostPct > 0.005 ? 'warn' : ''}">${s?.lost ?? 0}</td><td class="${age > 3 && k !== 'ppi' && k !== 'hr' ? 'bad' : ''}">${age != null ? `${age.toFixed(1)} s` : '--'}</td></tr>`);
  }
  setHTML(main.querySelector('[data-k="health"]'), rows.join(''));
  setHTML(main.querySelector('[data-k="steps"]'), (e.linkState?.steps || []).map((s) => `<li class="${s.state}"><span class="s"></span><span>${T.connect.steps[s.name] || s.name}${s.attempts > 1 ? ` <span class="dim">(try ${s.attempts})</span>` : ''}</span><span class="t">${s.ms != null ? `+${(s.ms / 1000).toFixed(1)} s` : ''}</span></li>`).join(''));
  for (const L of lanes) {
    if (L.noRate) continue;
    const s = e.stats?.[L.key], age = s?.lastRx != null ? Math.max(0, t - s.lastRx) : null;
    $$(`[data-r="${L.key}"]`, main).forEach((x) => setText(x, s?.hz ? `${s.hz.toFixed(1)} Hz` : '--'));
    $$(`[data-a="${L.key}"]`, main).forEach((x) => { setText(x, age != null ? `${age.toFixed(1)} s ago` : '--'); x.className = age > 3 ? 'bad' : ''; });
  }
}

export function drawMonitor(t) {
  if (!root || root._mode !== 'data') return;
  const aid = infoOf(id).athlete?.id, pins = S.marks.filter((m) => m.target === 'all' || m.target === aid);
  for (const L of lanes) drawLane(L.c, L, t, pins);
}
export const unmountMonitor = () => { root = null; lanes = []; };
export const monitorId = () => id;
