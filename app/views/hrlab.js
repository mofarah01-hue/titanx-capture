// HR lab (Engineering > HR lab): the motion robust heart rate, live, one column per connected sensor.
// Big gated HR with its zone and confidence, then what the engine saw: the fused PPG before motion
// removal, the cleaned PPG with every beat it found (filled = used, red = rejected by an impact or
// off the tracked rate), |a| with the impact threshold, how the bpm is made (spectral, beat intervals, blend, shown,
// Polar dashed), and HR over 2 minutes against Polar's own HR. A card per sensor walks the chain with the live numbers.
// The Show toggle (Clean view / Full view) only hides lanes; it is kept in localStorage.
import { S, now, slotIds, athleteName, pcHr, liveHr, zoneFor, maxHrFor } from '../state.js';
import { esc, setHTML, setText, $, $$, ZONE_NAMES } from '../ui.js';
import { drawLane } from '../draw.js';

let root = null, cols = [];
const f0 = (v) => (v == null || !Number.isFinite(v) ? '--' : Math.round(v));
const pc = (v) => `${Math.round((v || 0) * 100)} %`;
const KEY = 'hrlab.view';
const getView = () => { try { return localStorage.getItem(KEY) === 'clean' ? 'clean' : 'full'; } catch { return 'full'; } };
const setView = (v) => { try { localStorage.setItem(KEY, v); } catch { /* display only: nothing to lose */ } };
const word = (tok, w) => `<span style="color:var(--${tok})">${w}</span>`;
const LEGEND = [word('gyro', 'spectral'), word('mag', 'beat intervals'), word('acc', 'blend'), word('z5', 'shown'), word('polar', 'Polar (dashed)')].join(' · ');
// name, height, header text on the right, optional (hidden in Clean view)
const LANES = [
  ['FUSED PPG · BEFORE MOTION REMOVAL', 78, '', true],
  ['CLEANED PPG · BEATS (RED = REJECTED)', 96, '', false],
  ['|a| IN g · IMPACT LINE', 64, '', false],
  ['HOW THE BPM IS MADE · 2 MIN', 96, LEGEND, false],
  ['HR · OURS (RED) AND POLAR (DASHED) · 2 MIN', 96, '', false],
  ['CONFIDENCE · GATE LINE', 52, '', true],
];

export function mountHrLab(container) {
  root = container;
  const ids = slotIds().filter((id) => S.links.has(id));
  const view = getView();
  root.innerHTML = `<div class="page hrlab${view === 'clean' ? ' clean' : ''}">
    <div class="hrl-show"><span class="dim">Show</span><div class="seg" data-k="show">${[['clean', 'Clean view'], ['full', 'Full view']].map(([v, n]) => `<button type="button" data-v="${v}" aria-pressed="${v === view}">${n}</button>`).join('')}</div></div>
    ${ids.length ? `<div class="hrl-grid">${ids.map(col).join('')}</div>` : `<div class="card"><h2>No sensor connected</h2><p>Connect one from Titan X &gt; Live, then switch back here. The connection stays up when you switch.</p></div>`}
    <p class="dim">Our heart rate: every PPG channel, ACC, GYRO and MAG through the Motion HR chain (settings on the Motion HR tab), on this device. Zones: % of max HR (Polar's five zones); max HR from the athlete list, or 208 &minus; 0.7 &times; age.</p></div>`;
  $('[data-k="show"]', root).addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-v]'); if (!b) return;
    setView(b.dataset.v); $('.hrlab', root).classList.toggle('clean', b.dataset.v === 'clean');
    $$('[data-k="show"] button', root).forEach((n) => n.setAttribute('aria-pressed', String(n === b)));
  });
  cols = ids.map((id) => {
    const c = $(`[data-id="${id}"]`, root), e = S.links.get(id), d = e.data, cs = $$('canvas.lane-c', c), g = S.mhr.impact.g;
    const lanes = [
      { auto: true, minSpan: 0.5, win: 10, series: [{ buf: d.ppgBp, color: 'ppg', lw: 1.2 }], empty: 'Waiting for PPG (about 8 s)' },
      { auto: true, minSpan: 0.5, win: 10, series: [{ buf: d.clean, color: 'ppg2', lw: 1.4 }, { buf: d.beats, color: 'ok', dots: true }, { buf: d.beatsBad, color: 'bad', dots: true }], empty: 'Waiting for PPG (about 8 s)' },
      { range: [0, Math.max(8, g + 2)], ticks: [1, g], win: 10, series: [{ buf: d.accG, color: 'acc', lw: 1.2 }], empty: 'No accelerometer' },
      { range: [40, 210], ticks: [60, 100, 140, 180], win: 120, series: [{ buf: d.hr, color: 'polar', dash: true, lw: 1.4, gapS: 12 }, { buf: d.hrSpec, color: 'gyro', lw: 1.3, gapS: 5 }, { buf: d.hrBeats, color: 'mag', lw: 1.3, gapS: 5 }, { buf: d.hrBlend, color: 'acc', lw: 1.6, gapS: 5 }, { buf: d.pcHr, color: 'z5', lw: 2.2, gapS: 5 }], empty: 'No estimate yet' },
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
  <div class="hrl-how"><h4>How the bpm is estimated</h4><table class="kv hrl-kv" data-k="how"></table></div>
  <div class="lanes">${LANES.map(([n, h, lg, opt], i) => `<div class="lane"${opt ? ' data-opt="1"' : ''}><div class="lane-h"><span class="ln"><span>${n}</span></span><span class="lr" data-k="l${i}">${lg}</span></div><canvas class="lane-c" style="--lh:${h}px"></canvas></div>`).join('')}</div>
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
    setHTML($('[data-k="how"]', c), how(e, r));
    const d = e.data, lastB = d.beats.t.length;
    setText($('[data-k="l1"]', c), `${lastB ? d.beats.t.filter((x) => x > t - 10).length : 0} used, ${d.beatsBad.t.filter((x) => x > t - 10).length} rejected in 10 s`);
  }
}

export function drawHrLab(t) { if (root) for (const { lanes } of cols) for (const L of lanes) if (L.c?.offsetParent) drawLane(L.c, L, t); }
export const unmountHrLab = () => { root = null; cols = []; };

// The chain in plain steps, each with its live number (r = the engine's last once a second answer).
function how(e, r) {
  if (!r) return '<tr><td colspan="2" class="dim">Waiting for 8 s of PPG</td></tr>';
  const g = S.mhr.gate, both = r.spec != null && r.peaks != null, gap = both ? Math.abs(r.spec - r.peaks) : null;
  const shown = r.bpm != null;
  return [
    ['1 Channels fused', `${r.weights.length} PPG channels, weights ${r.weights.map((w) => w.toFixed(2)).join(' · ')}`],
    ['2 Motion removed', `movement ${r.motionG.toFixed(2)} g${r.cadence ? `, step rhythm ${f0(r.cadence)} /min${r.notchOn ? ' cut out' : ''}` : ', no rhythm found'}${r.frozen ? ' · <b class="warn">impact: holding</b>' : ''}`],
    ['3 Spectral peak', r.spec != null ? `<b>${f0(r.spec)} bpm</b>, quality ${pc(r.specQ)}` : 'no clear line in the spectrum'],
    ['4 Beats', r.peaks != null ? `${r.beats} beats found → gaps between them → median <b>${f0(r.peaks)} bpm</b>, quality ${pc(r.peaksQ)}` : `${r.beats} beats found, too few clean gaps for a median`],
    ['5 Blend, tracker', r.tracked != null ? `<b>${f0(r.tracked)} bpm</b> · ${both ? (gap <= 8 ? 'spectral and beats agree' : `spectral and beats differ by ${f0(gap)} bpm`) : 'only one method has an answer'}${S.mhr.tracker.on ? ' · tracker limits the jump per second' : ''}` : 'no blend yet'],
    ['6 Confidence', `${pc(r.conf)} ${g.on ? `vs gate ${pc(g.min)} → ` : '(gate off) → '}${shown ? `<b>shown, ${f0(r.bpm)} bpm</b>` : `<b class="warn">hidden</b>`}${r.why && !r.why.startsWith('confidence') ? ` · <span class="dim">${esc(r.why)}</span>` : ''}`],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
}
