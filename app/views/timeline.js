// Session timeline: every sensor as a lane on one time axis, events as pins across lanes.
import T from '../../strings/en.js';
import { S, slotIds, infoOf, athleteName, positionOf, zoneFor, now } from '../state.js';
import { $, $$ } from '../ui.js';
import { drawTimeline } from '../draw.js';

let root = null;
export function mountTimeline(container) {
  root = container;
  root.innerHTML = `<div class="tl-bar"><h2>Session timeline</h2>
    <span class="seg" role="group" aria-label="Zoom"><button data-z="all">Whole session</button><button data-z="5">Last 5 min</button></span>
    <span class="legend"><span><i class="dashk"></i>Reference HR</span><span><i class="solidk"></i>Our HR, once added</span><span><i class="hatch"></i>No data, never filled in</span><span>Bottom strip: movement from ACC</span></span></div>
    <p class="dim" data-k="none" hidden>No session is running. Start a session to see its timeline.</p>
    <div class="tl-wrap"><canvas aria-label="Heart rate per sensor on one time axis, with events"></canvas></div>`;
  $$('[data-z]', root).forEach((b) => b.addEventListener('click', () => { S.tlZoom = b.dataset.z; refreshTimeline(now()); }));
  refreshTimeline(now());
}

export function refreshTimeline(t) {
  if (!root) return;
  $$('[data-z]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === S.tlZoom)));
  root.querySelector('[data-k="none"]').hidden = !!S.session;
  const rows = slotIds().map((id) => {
    const e = S.links.get(id);
    return {
      name: athleteName(id), sub: T.positions[positionOf(id)] || `Sensor ${id.slice(-4)}`, mode: e?.mode || infoOf(id).sensor?.mode || 'polar',
      hrBuf: e?.data.hr || { t: [], v: [] }, moveBuf: e?.data.move, firstT: e?.data.firstT ?? null, athleteId: infoOf(id).athlete?.id, zoneOf: (hr) => zoneFor(id, hr),
      gaps: S.gaps.filter((g) => g.id === id),
    };
  });
  const marks = S.marks.map((m) => ({ ...m, who: m.target === 'all' ? '' : (S.reg.athletes.find((a) => a.id === m.target)?.name || '').split(' ')[0] }));
  drawTimeline($('canvas', root), rows, marks, t, S.tlZoom);
}
export const unmountTimeline = () => { root = null; };
