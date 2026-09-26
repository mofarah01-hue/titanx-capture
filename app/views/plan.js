// Training plan tab: example plans (Low, Mid, High intensity), a plan's phases, and the one running.
import T from '../../strings/en.js';
import { PLANS, INTENSITY, STATUS, expand, totalS, holdPlan, current } from '../../core/plans.js';
import { S, now } from '../state.js';
import { esc, setText, $, $$ } from '../ui.js';

let root = null, ctx = null, chosen = PLANS[0].id;

const mins = (s) => (Number.isFinite(s) ? (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`) : T.plan.untilStopped);
const clock = (s) => (Number.isFinite(s) ? `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}` : T.plan.untilStopped);
export const zoneText = ([lo, hi]) => (lo === hi ? `Zone ${lo}` : `Zones ${lo} to ${hi}`);
const zoneChip = ([lo, hi]) => `<span class="zb" style="--zc:var(--z${hi})"><i></i><b>${lo === hi ? `Z${lo}` : `Z${lo} to ${hi}`}</b></span>`;
const intensityChip = (k) => `<span class="ichip" data-i="${k}">${T.plan.intensity[k]} · ${T.plan.zonesOf[k]}</span>`;

/** Phases as a bar: width by duration, colour by the top zone of each target. */
export function phaseBar(phases) {
  const total = phases.reduce((a, p) => a + (Number.isFinite(p.s) ? p.s : 600), 0);
  return `<div class="pbar">${phases.map((p) => `<i style="flex:${(Number.isFinite(p.s) ? p.s : 600) / total};background:var(--z${p.zone[1]})" title="${esc(p.name)}, ${zoneText(p.zone)}, ${mins(p.s)}"></i>`).join('')}</div>`;
}

/** ctx: { start(plan), next(), stop() } */
export function mountPlan(container, c) {
  root = container; ctx = c;
  root.innerHTML = `<div class="page">
    <div class="plan-head">
      <h2>${T.plan.title}</h2>
      <p>${esc(T.plan.intro)}</p>
      <div class="legend plan-legend">${['below', 'on', 'above'].map((k) => `<span class="tstat" data-s="${k}">${STATUS[k].icon} ${T.plan.status[k]}</span>`).join('')}
        <span class="sep"></span>${Object.keys(INTENSITY).map(intensityChip).join('')}</div>
    </div>
    <div data-k="now"></div>
    <div class="plans">${PLANS.map((p) => `<button class="plancard" data-id="${p.id}">
        <span class="pc-top"><b>${esc(p.name)}</b>${intensityChip(p.intensity)}</span>
        <span class="dim">${esc(p.about)}</span>
        ${phaseBar(expand(p))}
        <span class="dim">${mins(totalS(p))} · ${expand(p).length} phases</span>
      </button>`).join('')}</div>
    <div class="card plan-detail" data-k="detail"></div>
    <div class="hold"><span class="dim">${T.plan.hold}</span>${[1, 2, 3, 4, 5].map((z) => `<button class="btn" data-hold="${z}" style="border-color:var(--z${z})">Zone ${z}</button>`).join('')}</div>
  </div>`;
  $$('.plancard', root).forEach((b) => b.addEventListener('click', () => { chosen = b.dataset.id; renderDetail(); }));
  $$('[data-hold]', root).forEach((b) => b.addEventListener('click', () => ctx.start(holdPlan(+b.dataset.hold))));
  renderDetail();
  refreshPlan(now());
}

function renderDetail() {
  $$('.plancard', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === chosen)));
  const p = PLANS.find((x) => x.id === chosen), ph = expand(p);
  let at = 0;
  $('[data-k="detail"]', root).innerHTML = `<div class="pc-top"><h3>${esc(p.name)}</h3>${intensityChip(p.intensity)}<span class="dim">${mins(totalS(p))}</span></div>
    ${phaseBar(ph)}
    <table class="phases"><thead><tr><th>Starts</th><th>Phase</th><th>Target</th><th>Length</th></tr></thead><tbody>${ph.map((x) => { const r = `<tr><td class="dim">${clock(at)}</td><td>${esc(x.name)}</td><td>${zoneChip(x.zone)}</td><td>${mins(x.s)}</td></tr>`; at += x.s; return r; }).join('')}</tbody></table>
    <div class="foot"><button class="btn primary big" data-start>${S.session ? T.plan.start : T.plan.startSession}</button></div>`;
  $('[data-start]', root).addEventListener('click', () => ctx.start(p));
}

/** 4 Hz: the running plan panel. Rebuilt only when the phase changes; the countdown updates in place. */
export function refreshPlan(t) {
  if (!root) return;
  const ph = current(S.plan, t), box = $('[data-k="now"]', root);
  const key = !S.plan ? '' : !ph ? `done:${S.plan.name}` : `${S.plan.name}:${ph.index}`;
  if (box._key !== key) {
    box._key = key;
    box.innerHTML = !S.plan ? ''
      : !ph ? `<div class="plannow"><b>${esc(S.plan.name)}</b><span>${T.plan.finished}</span><button class="btn" data-stop>${T.plan.stop}</button></div>`
      : `<div class="plannow" style="--zc:var(--z${ph.zone[1]})"><span class="eyebrow">${T.plan.running}</span><b>${esc(S.plan.name)}</b>
          <span>${esc(ph.name)} <span class="dim">(${ph.index + 1} of ${ph.count})</span></span>${zoneChip(ph.zone)}
          <span class="num big-left" data-k="left"></span>
          <span class="spacer"></span><button class="btn" data-next>${T.plan.next}</button><button class="btn" data-stop>${T.plan.stop}</button></div>`;
    box.querySelector('[data-next]')?.addEventListener('click', () => ctx.next());
    box.querySelector('[data-stop]')?.addEventListener('click', () => ctx.stop());
  }
  if (ph) setText(box.querySelector('[data-k="left"]'), clock(ph.left));
}
export const unmountPlan = () => { root = null; };
export { clock as planClock };
