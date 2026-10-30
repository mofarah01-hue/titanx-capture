// HR lab (Engineering > HR lab): the motion robust heart rate, live, one column per connected sensor.
// Big gated HR with its zone and confidence, then what the engine saw: the fused PPG before motion
// removal, the cleaned PPG with every beat it found (filled = used, red = rejected by an impact or
// off the tracked rate), |a| with the impact threshold, and HR over 2 minutes against Polar's own HR.
import { S, now, slotIds, athleteName, pcHr, liveHr, zoneFor, maxHrFor } from '../state.js';
import { esc, setHTML, setText, $, $$, ZONE_NAMES } from '../ui.js';
import { drawLane } from '../draw.js';

let root = null, cols = [];
const f0 = (v) => (v == null || !Number.isFinite(v) ? '--' : Math.round(v));

export function mountHrLab(container) {
  root = container;
  const ids = slotIds().filter((id) => S.links.has(id));
  root.innerHTML = `<div class="page hrlab">${ids.length ? `<div class="hrl-grid">${ids.map(col).join('')}</div>` : `<div class="card"><h2>No sensor connected</h2><p>Connect one from Titan X &gt; Live, then switch back here. The connection stays up when you switch.</p></div>`}
    <p class="dim">Our heart rate: every PPG channel, ACC, GYRO and MAG through the Motion HR chain (settings on the Motion HR tab), on this device. Zones: % of max HR (Polar's five zones); max HR from the athlete list, or 208 &minus; 0.7 &times; age.</p></div>`;
  cols = ids.map((id) => {
    const c = $(`[data-id="${id}"]`, root), e = S.links.get(id), d = e.data, cs = $$('canvas.lane-c', c), g = S.mhr.impact.g;
    const lanes = [
      { auto: true, minSpan: 0.5, win: 10, series: [{ buf: d.ppgBp, color: 'ppg', lw: 1.2 }], empty: 'Waiting for PPG (about 8 s)' },
      { auto: true, minSpan: 0.5, win: 10, series: [{ buf: d.clean, color: 'ppg2', lw: 1.4 }, { buf: d.beats, color: 'ok', dots: true }, { buf: d.beatsBad, color: 'bad', dots: true }], empty: 'Waiting for PPG (about 8 s)' },
      { range: [0, Math.max(8, g + 2)], ticks: [1, g], win: 10, series: [{ buf: d.accG, color: 'acc', lw: 1.2 }], empty: 'No accelerometer' },
      { range: [40, 210], ticks: [60, 100, 140, 180], win: 120, series: [{ buf: d.hr, color: 'polar', dash: true, lw: 1.6, gapS: 12 }, { buf: d.pcHr, color: 'z5', lw: 2, gapS: 5 }], empty: 'No heart rate yet' },
      { range: [0, 1], ticks: [S.mhr.gate.min], win: 120, series: [{ buf: d.pcConf, color: 'accent', lw: 1.4, gapS: 5 }], empty: 'No estimate yet' },
    ];
    lanes.forEach((L, i) => { L.c = cs[i]; });
    return { id, c, lanes };
  });
  refreshHrLab(now());
}

const col = (id) => `<section class="box hrl-col" data-id="${id}">
  <div class="hrl-h"><h3>${esc(athleteName(id))} · ${id}</h3><span class="dim" data-k="mode"></span></div>
  <div class="hrl-top"><div class="hrl-big"><b data-k="bpm">--</b><span>bpm</span></div>
    <div class="hrl-side"><div class="zbar" data-k="zbar">${ZONE_NAMES.map((n, z) => `<i style="--zc:var(--z${z})" title="Z${z} ${n}">Z${z}</i>`).join('')}</div>
      <div data-k="conf" class="hrl-conf"></div><div class="dim" data-k="why"></div></div></div>
  <table class="kv hrl-kv" data-k="kv"></table>
  <div class="lanes">${['FUSED PPG · BEFORE MOTION REMOVAL', 'CLEANED PPG · BEATS (RED = REJECTED)', '|a| IN g · IMPACT LINE', 'HR · OURS (RED) AND POLAR (DASHED) · 2 MIN', 'CONFIDENCE · GATE LINE'].map((n, i) => `<div class="lane"><div class="lane-h"><span class="ln"><span>${n}</span></span><span class="lr" data-k="l${i}"></span></div><canvas class="lane-c" style="--lh:${[78, 96, 64, 96, 52][i]}px"></canvas></div>`).join('')}</div>
</section>`;

export function refreshHrLab(t) {
  if (!root) return;
  for (const { id, c } of cols) {
    const e = S.links.get(id); if (!e) continue;
    const r = e.mhrLast, p = pcHr(e, t), z = p ? zoneFor(id, p.bpm) : null, ref = liveHr(e, t), max = maxHrFor(id);
    setText($('[data-k="mode"]', c), e.kind === 'senswear' ? 'SensWear · green, IR, red fused' : e.mode === 'max' ? 'Polar Max mode · 3 greens − ambient · ACC, GYRO, MAG' : 'Polar mode · 3 greens − ambient · ACC only (Max mode adds GYRO and MAG)');
    setText($('[data-k="bpm"]', c), p ? String(Math.round(p.bpm)) : '--');
    $('[data-k="bpm"]', c).style.color = z == null ? '' : `var(--z${z})`;
    $$('.zbar i', c).forEach((n, k) => n.classList.toggle('on', k === z));
    setHTML($('[data-k="conf"]', c), r ? `Confidence <b>${Math.round(r.conf * 100)} %</b>${S.mhr.gate.on ? ` <span class="dim">(gate ${Math.round(S.mhr.gate.min * 100)} %)</span>` : ''}${z != null ? ` · Z${z} ${ZONE_NAMES[z]}` : ''}${max ? '' : ' · <span class="warn">no max HR set: zones off</span>'}` : '');
    setText($('[data-k="why"]', c), r?.why || (r ? '' : 'Waiting for 8 s of PPG'));
    setHTML($('[data-k="kv"]', c), r ? [
      ['Spectral / beats', `${f0(r.spec)} / ${f0(r.peaks)} bpm`],
      ['Movement', `${r.motionG.toFixed(2)} g${r.cadence ? ` · rhythm ${f0(r.cadence)} /min${r.notchOn ? ' (notched)' : ''}` : ''}`],
      ['Impacts', `${r.impacts}${r.frozen ? ' · <b class="warn">holding</b>' : ''}`],
      ['Channel weights', r.weights.map((w) => w.toFixed(2)).join(' · ')],
      ['Polar HR', e.mode === 'max' ? 'off in Max mode' : ref != null ? `${ref} bpm` : '--'],
    ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('') : '');
    const d = e.data, lastB = d.beats.t.length;
    setText($('[data-k="l1"]', c), `${lastB ? d.beats.t.filter((x) => x > t - 10).length : 0} used, ${d.beatsBad.t.filter((x) => x > t - 10).length} rejected in 10 s`);
  }
}

export function drawHrLab(t) { if (root) for (const { lanes } of cols) for (const L of lanes) if (L.c?.offsetParent) drawLane(L.c, L, t); }
export const unmountHrLab = () => { root = null; cols = []; };
