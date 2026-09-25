// Home, the pre session checklist, and the end of session screen.
import T from '../../strings/en.js';
import { S, slotState, now } from '../state.js';
import { TICK, WARN, TODO, esc, setHTML, $, fmtClock, fmtMB } from '../ui.js';

let root = null, ctx = null, kind = '';

/** ctx: { runDemo(), toChecklist(), startSession(label), download(name), allowSaving(), openSetup() } */
export function mountHome(container, c) {
  root = container; ctx = c; kind = 'home';
  const demo = S.sim > 0;
  root.innerHTML = `<div class="page" style="max-width:760px"><div class="card">
    <span class="eyebrow">TITAN X CAPTURE</span><h2>${demo ? 'Try it with simulated sensors' : 'Ready when you are'}</h2>
    <p>${demo ? `Run the demo to start a session and connect ${S.sim} simulated sensor${S.sim > 1 ? 's' : ''} in one click. Or go through the real steps: start a session, then connect each sensor from its panel.` : 'Start a session, connect each sensor, and recording starts by itself. Everything is saved to the Sa7a folder and reaches Mohammad through Google Drive.'}</p>
    <ul class="checks" data-k="state"></ul>
    <div class="foot">${demo ? '<button class="btn primary big" data-demo>Run the demo</button><button class="btn big" data-go>Start a session</button>' : '<button class="btn primary big" data-go>Start a session</button>'}<span class="spacer"></span><button class="btn" data-setup>Setup</button></div>
  </div></div>`;
  root.querySelector('[data-demo]')?.addEventListener('click', () => ctx.runDemo());
  root.querySelector('[data-go]').addEventListener('click', () => ctx.toChecklist());
  root.querySelector('[data-setup]').addEventListener('click', () => ctx.openSetup());
  refreshSession();
}

let ticks = { lid: false, charged: false, stickers: false }, power = null;
export function mountChecklist(container, c) {
  root = container; ctx = c; kind = 'check';
  ticks = { lid: false, charged: false, stickers: false };
  navigator.getBattery?.().then((b) => { power = b; b.addEventListener('chargingchange', refreshSession); refreshSession(); }).catch(() => {});
  root.innerHTML = `<div class="page" style="max-width:760px"><div class="card">
    <span class="eyebrow">BEFORE YOU START</span><h2>${T.checklist.title}</h2>
    <ul class="checks" data-k="items"></ul>
    <label class="field" for="label">${T.checklist.label}<input id="label" autocomplete="off" placeholder="${T.checklist.labelHint}" maxlength="40"></label>
    <div class="foot"><button class="btn primary big" data-start>${T.checklist.start}</button><span class="spacer"></span><button class="btn" data-back>Back</button></div>
  </div></div>`;
  root.querySelector('[data-back]').addEventListener('click', () => ctx.home());
  root.querySelector('[data-start]').addEventListener('click', () => ctx.startSession(root.querySelector('#label').value.trim() || 'session'));
  root.addEventListener('change', (e) => { const k = e.target.dataset?.tick; if (k) { ticks[k] = e.target.checked; refreshSession(); } });
  root.addEventListener('click', (e) => { if (e.target.closest('[data-allow]')) ctx.allowSaving(); });
  refreshSession();
}

export function mountEnd(container, c) {
  root = container; ctx = c; kind = 'end';
  const r = S.summary || {};
  const ok = r.drive === true;
  root.innerHTML = `<div class="page" style="max-width:820px"><div class="card">
    <span class="eyebrow">SESSION ENDED</span><h2>${ok ? T.end.title : 'Session saved on this Mac'}</h2>
    <div class="stats">
      <div class="stat"><span class="dim">${T.end.length}</span><span class="big">${fmtClock(r.durationS || 0)}</span></div>
      <div class="stat"><span class="dim">${T.end.sensors}</span><span class="big">${r.sensors ?? 0}</span></div>
      <div class="stat"><span class="dim">${T.end.marks}</span><span class="big">${r.marks ?? 0}</span></div>
    </div>
    <ul class="checks">${ok
      ? `<li class="check">${TICK}<span><b>${esc(T.end.synced(S.folder.name || 'Sa7a', fmtMB(r.zipBytes || r.bytes || 0)))}</b><br><span class="dim">${esc(r.name || '')}.zip. Leave the Mac on and online for a few minutes so Google Drive finishes.</span></span></li>`
      : `<li class="check">${WARN}<span><b class="warn">${T.end.failed}</b><br><span class="dim">${esc(r.reason || '')}</span></span></li>`}</ul>
    ${ok ? '' : `<div class="foot" style="border:0;padding:0"><button class="btn primary" data-dl>${T.end.download}</button></div><p>${T.end.dragHow}</p>`}
    <div class="foot"><button class="btn primary big" data-again>Start another session</button><span class="spacer"></span><button class="btn" data-home>Done</button></div>
  </div></div>`;
  root.querySelector('[data-dl]')?.addEventListener('click', () => ctx.download(r.name));
  root.querySelector('[data-again]').addEventListener('click', () => ctx.toChecklist());
  root.querySelector('[data-home]').addEventListener('click', () => ctx.home());
}

function folderLine() {
  if (S.sim && !S.folder.handle) return [TODO, 'No save folder picked. In sim mode recordings stay on this computer unless you pick one in Setup.'];
  if (S.folder.permission === 'granted') return S.folder.shared === false ? [WARN, `<b class="warn">${T.storage.localOnly}</b>`] : [TICK, `${T.checklist.items.folder}: ${esc(S.folder.name)}`];
  if (S.folder.permission === 'prompt') return [WARN, `${T.checklist.folderMissing} <button class="btn" data-allow>${T.storage.allow}</button>`];
  return [WARN, 'No save folder yet. Open Setup, step 6.'];
}

export function refreshSession() {
  if (!root) return;
  if (kind === 'home') {
    const rows = [folderLine()];
    const n = S.reg.sensors.length;
    rows.push(n ? [TICK, `${n} sensor${n > 1 ? 's' : ''} known: ${esc(S.reg.sensors.map((s) => s.deviceId.slice(-4)).join(', '))}`] : [TODO, 'No sensors known yet. You name each one the first time it connects.']);
    setHTML($('[data-k="state"]', root), rows.map(([i, t]) => `<li class="check">${i}<span>${t}</span></li>`).join(''));
  }
  if (kind === 'check') {
    const charging = power ? power.charging : null;
    const conn = [...S.links.values()].filter((e) => ['ok', 'raw', 'starting'].includes(slotState(e, now())));
    const batt = conn.map((e) => `${e.id.slice(-4)} ${e.linkState?.battery ?? '?'}%`).join(', ');
    const rows = [
      [charging === true ? TICK : charging === false ? WARN : TODO, charging === false ? `<b class="warn">${T.checklist.items.power}</b>: the laptop is on battery` : T.checklist.items.power],
      [ticks.lid ? TICK : TODO, `<label><input type="checkbox" data-tick="lid" ${ticks.lid ? 'checked' : ''}> ${T.checklist.items.lid}</label>`],
      folderLine(),
      [ticks.charged ? TICK : TODO, `<label><input type="checkbox" data-tick="charged" ${ticks.charged ? 'checked' : ''}> ${T.checklist.items.charged}</label>${batt ? ` <span class="dim">(${batt})</span>` : ''}`],
      [ticks.stickers ? TICK : TODO, `<label><input type="checkbox" data-tick="stickers" ${ticks.stickers ? 'checked' : ''}> ${T.checklist.items.stickers}</label>`],
    ];
    setHTML($('[data-k="items"]', root), rows.map(([i, t]) => `<li class="check">${i}<span>${t}</span></li>`).join(''));
  }
}
export const unmountSession = () => { root = null; kind = ''; };
