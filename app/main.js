// TitanX Capture: boot, routing, sessions, events, storage status. Everything the remote user sees
// starts here. URL options: ?sim=N fakes N sensors, ?setup=reset clears saved settings (never
// recordings), ?debug=1 logs every raw packet to the console.
import T from '../strings/en.js';
import { VERSION, BUILT, PAGES_DEMO } from '../core/version.js';
import { browserCheck, watchBluetooth, createWakeLock, watchForUpdates, reloadFresh } from '../core/platform.js';
import { folderState, pickFolder, allowSaving, writeTest, isSharedFolder } from '../core/storage/folder.js';
import { kvGet, kvSet, kvClear } from '../core/storage/kv.js';
import { loadRegistry, saveRegistry, emptyRegistry, upsertAthlete, upsertSensor } from '../core/registry.js';
import { SimRadio, SIM_IDS } from '../core/sim/fake-sensor.js';
import { SimSensWearRadio, SIM_SW_IDS } from '../core/sim/fake-senswear.js';
import { zipToBlob } from '../core/storage/zip.js';
import { S, bus, emit, now, ingest, newData, log, athletesInView, slotState } from './state.js';
import { initLinks, connect, connectSim, disconnectAll } from './links.js';
import { readTokens } from './draw.js';
const rereadTokens = readTokens;
import { ICO, EVENTS, esc, el, $, $$, toast, say, modal, fmtClock, fmtMS } from './ui.js';
import * as live from './views/live.js';
import * as mon from './views/monitor.js';
import * as tl from './views/timeline.js';
import * as wiz from './views/wizard.js';
import * as ses from './views/session.js';
import * as planView from './views/plan.js';
import { startRun, advance, skip } from '../core/plans.js';
import { openHelp } from './views/help.js';
import * as eng from './views/eng.js';
import * as cmp from './views/compare.js';
import * as lab from './views/hrlab.js';
import * as mhrView from './views/mhr.js';
import { mountRuns, unmountRuns } from './views/runs.js';
import { uploadSession } from '../core/storage/upload.js';
import { resetMhr, maxHrFor } from './state.js';

const params = new URLSearchParams(location.search);
// senswear.html sets data-kind="senswear": same front end, SensWear back end (DECISIONS D42, D45).
S.kind = document.documentElement.dataset.kind === 'senswear' ? 'senswear' : 'polar';
S.sim = Math.max(0, Math.min(10, parseInt(params.get('sim') || '0', 10) || 0));
// The live link is a demo until the Phase 1 release: simulated sensors only, never a real one.
S.demo = PAGES_DEMO && location.hostname.endsWith('github.io');
if (S.demo && !S.sim) S.sim = 2;
S.debug = params.get('debug') === '1';
// Pitch screenshots: ?pitch=1 (simulated sensors only) hides development chrome and shows an
// illustrative Our HR. tools/shots.mjs uses it.
S.pitch = S.sim > 0 && params.get('pitch') === '1';
if (S.pitch) document.documentElement.classList.add('pitch');
const CKPT_S = parseInt(params.get('ckpt') || '', 10) || undefined; // tests only: Drive copy interval in seconds (default 300)

let worker, wake, W = {}, simRadio = null;
const pending = new Map();
const ask = (msg, reply) => new Promise((resolve, reject) => { pending.set(reply, { resolve, reject }); worker.postMessage(msg); });
const appInfo = () => ({ version: VERSION, built: BUILT, userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform, simulated_sensors: S.sim || 0 });

boot().catch((e) => { log('error', `boot: ${e.message}`); document.body.innerHTML = `<div class="gate"><div class="card"><h2>The app could not start</h2><p>${esc(e.message)}</p><p>Reload the page. If it happens again, send a screenshot of this to Mohammad.</p></div></div>`; });

async function boot() {
  if (params.get('setup') === 'reset') {
    await kvClear(); try { localStorage.clear(); } catch { /* blocked storage */ }
    history.replaceState(null, '', location.pathname + (S.sim ? `?sim=${S.sim}` : ''));
    setTimeout(() => toast('Saved settings cleared. Setup starts again. Recordings on this computer were kept.'), 500);
  }
  S.env = browserCheck();
  if (!S.env.ok && !(S.sim && 'storage' in navigator)) { gate(S.env); return; }
  if (S.kind === 'senswear') document.title = 'Titan X · SensWear';
  shell();
  readTokens();
  worker = new Worker(new URL('../core/capture-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => { log('error', `worker: ${e.message}`); toast('The recorder stopped working. Reload the page; everything saved so far is kept.'); };
  worker.postMessage({ type: 'init', debug: S.debug });
  wake = createWakeLock((on) => { S.wake = on; });

  let radio = null;
  if (S.sim) { radio = S.kind === 'senswear' ? new SimSensWearRadio(S.sim) : new SimRadio(S.sim, { distinct: S.sim >= 8 }); seedSimRegistry(); S.bluetooth = true; }
  else watchBluetooth((on) => { S.bluetooth = on; banners(); });
  simRadio = radio;
  if (radio) window.__simRadio = radio; // tests and the console reach the simulated sensors
  initLinks(worker, radio);

  const f = await folderState();
  S.folder = { handle: f.handle, name: f.name, permission: f.permission, shared: null };
  // Tests only: ?testfolder=<name> uses a folder in the browser's private storage as the save folder.
  // (Storing a folder handle in IndexedDB closes the page in Playwright's headless Chrome.)
  if (params.get('testfolder')) {
    const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(params.get('testfolder'), { create: true });
    S.folder = { handle: h, name: h.name, permission: 'granted', shared: null };
  }
  if (S.folder.permission === 'granted') await folderReady();
  else if (!S.sim) { const r = await loadRegistry(null); S.reg = r.reg; S.regSource = r.source; }

  W = (await kvGet('wizard')) || {};
  resetMhr(await mhrView.loadMhr());
  watchForUpdates(VERSION, (info) => { S.update = info; banners(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.session) { S.hiddenWhileRecording = true; log('warn', 'window hidden during a session'); } banners(); });
  bus.addEventListener('change', (e) => onChange(e.detail));
  setInterval(tick, 250);
  setInterval(checkDegraded, 5000);
  requestAnimationFrame(frame);
  const startMode = params.get('mode') === 'eng' ? 'eng' : (() => { try { return localStorage.getItem('mode'); } catch { return null; } })();
  go(startMode === 'eng' ? 'hrlab' : W.done || S.sim || S.kind === 'senswear' ? 'home' : 'wizard');
}

function gate(env) {
  const msg = !window.isSecureContext ? T.gate.notSecure : env.tooOld ? T.gate.oldChrome(env.major) : T.gate.why(env.name);
  document.body.innerHTML = `<div class="gate"><div class="card"><span class="eyebrow">TITAN X CAPTURE</span><h2>${T.gate.title}</h2><p>${esc(msg)}</p>
    <div class="foot" style="border:0;padding:0"><a class="btn primary big" href="https://www.google.com/chrome/" target="_blank" rel="noopener">${T.gate.download}</a><button class="btn" id="cp">${T.gate.copyLink}</button></div><p class="dim">${T.gate.after}</p></div></div>`;
  $('#cp').addEventListener('click', () => navigator.clipboard?.writeText(location.href).then(() => toast('Address copied.'), () => toast(location.href, 10000)));
}

function seedSimRegistry() {
  if (S.kind === 'senswear') {
    const reg = emptyRegistry();
    const people = [['Test wearer', 190, 'forehead'], ['Second wearer', 195, 'left_ear'], ['Third wearer', null, 'right_ear']];
    for (let i = 0; i < Math.min(3, S.sim); i++) { const [name, maxHr, position] = people[i]; const a = upsertAthlete(reg, { name, maxHr }); upsertSensor(reg, SIM_SW_IDS[i], { athleteId: a.id, position, mode: 'senswear' }); }
    S.reg = reg; S.regSource = 'sim';
    return;
  }
  // Up to 7: one athlete wears two sensors (forehead, and back of head in Max rate mode) and one has
  // no max HR set, to show those cases. 8 to 10: a room of separate athletes, all in Polar mode.
  const room = S.sim >= 8;
  const people = room
    ? [['John Smith', 190, 'left_ear'], ['Emily Carter', 197, 'right_ear'], ['Mike Parsons', 192, 'forehead'], ['Jessica Moore', 194, 'left_ear'], ['Chris Johnson', 198, 'left_ear'],
      ['Sarah Miller', 203, 'right_ear'], ['David Brown', 186, 'forehead'], ['Ashley Davis', 196, 'back_of_head'], ['Ryan Wilson', 200, 'right_ear'], ['Megan Taylor', 188, 'left_ear']]
    : [['John Smith', 190, 'left_ear'], ['Emily Carter', 197, 'right_ear'], ['Mike Parsons', 192, 'forehead'], ['Mike Parsons', 192, 'back_of_head'], ['Jessica Moore', 198, 'left_ear'], ['Chris Johnson', 203, 'right_ear'], ['Sarah Miller', null, 'forehead']];
  const reg = emptyRegistry();
  for (let i = 0; i < S.sim; i++) {
    const [name, maxHr, position] = people[i];
    const a = reg.athletes.find((x) => x.name === name) || upsertAthlete(reg, { name, maxHr });
    upsertSensor(reg, SIM_IDS[i], { athleteId: a.id, position, mode: !room && i === 3 ? 'max' : 'polar' });
  }
  S.reg = reg; S.regSource = 'sim';
}

// ---------- shell ----------
function shell() {
  document.body.innerHTML = '';
  document.body.append(el(`<div class="app">
    <header class="top">
      <div class="brand"><span class="tx">TITAN X</span><span class="sep"></span><span class="sub">${S.kind === 'senswear' ? 'SENSWEAR · ENGINEERING' : 'SA7A LABS'}</span>${S.sim ? '<span class="simtag">SIMULATED</span>' : ''}
        <span class="modes" role="group" aria-label="Mode"><button data-mode="titanx">Titan X</button><button data-mode="eng">Engineering</button></span>
        <span class="views" role="group" aria-label="View" id="views"></span></div>
      <div class="rec idle" id="rec"><i class="dot" aria-hidden="true"></i><span class="clock" id="clock">00:00:00</span><span class="rec-l" id="recl">NOT RECORDING</span></div>
      <div class="hright">
        <button class="store" id="store" title="Save folder">${ICO.cloud}<span><b id="storeName">Sa7a Drive</b> <span class="dim" id="storeTxt"></span></span></button>
        <button class="hbtn" id="bEnd" hidden>End session</button>
        <button class="hbtn" id="bSetup">${ICO.gear}Setup</button>
        <button class="hbtn" id="bHelp">${ICO.help}Help</button>
      </div>
    </header>
    <div class="banners" id="banners"></div>
    <main id="main"></main>
    <footer class="events" id="events" aria-disabled="true">
      <span class="ev-t">ADD EVENT</span>
      <div class="evs">${EVENTS.map((e) => `<button class="ev" data-ev="${esc(e.label)}" style="--ec:var(--${e.color})">${ICO[e.icon]}<span>${esc(e.label)}</span></button>`).join('')}</div>
      <label class="field note" for="mNote">Note<input id="mNote" placeholder="${T.marks.notePlaceholder}" autocomplete="off" maxlength="200"></label>
      <label class="field" for="mTarget">${T.marks.target}<select id="mTarget"></select></label>
    </footer>
  </div>`));
  document.body.append(el(`<div class="ver">v${VERSION} · built ${BUILT}</div>`));
  $('#views').addEventListener('click', (ev) => { const b = ev.target.closest('[data-view]'); if (b) go(b.dataset.view); });
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => go(lastView[b.dataset.mode])));
  $('#bSetup').addEventListener('click', () => go('wizard'));
  $('#bHelp').addEventListener('click', () => openHelp(debugBundle));
  $('#bEnd').addEventListener('click', endSession);
  $('#store').addEventListener('click', storeClick);
  $$('[data-ev]').forEach((b) => b.addEventListener('click', () => addMark(b.dataset.ev)));
  $('#mNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') { if ($('#mNote').value.trim()) addMark('Note'); else toast('Type a note first, then press Enter or an event button.'); } });
  fillTargets();
}

function fillTargets() {
  const sel = $('#mTarget'), cur = sel.value;
  sel.innerHTML = `<option value="all">${T.marks.all}</option>` + athletesInView().map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ---------- routing ----------
const planCtx = { start: (p) => startPlan(p), next: () => nextPhase(), stop: () => stopPlan() };
const ctx = {
  runDemo: () => runDemo(),
  toChecklist: () => (S.session ? go('live') : go('checklist')), // the simulated demo only; real users go home: connect, name or skip, record
  connect: () => connect(null),
  home: () => go('home'),
  startSession: (label) => startSession(label),
  download: (name) => download(name),
  allowSaving: () => allowSavingClick(),
  openSetup: () => go('wizard'),
};
// Two modes on one page, so switching never drops a sensor: Titan X (what coaches see) and Engineering.
const VIEWS = {
  titanx: [['live', 'Live'], ['timeline', 'Timeline'], ['plan', T.plan.tab], ['compare', 'Compare']],
  eng: [['hrlab', 'HR lab'], ['mhr', 'Motion HR'], ['eng', 'Device'], ['runs', 'Past runs']],
};
const lastView = { titanx: 'live', eng: 'hrlab' };
function setMode(view) {
  const m = VIEWS.eng.some(([v]) => v === view) ? 'eng' : VIEWS.titanx.some(([v]) => v === view) || view === 'monitor' ? 'titanx' : S.mode || 'titanx';
  if (VIEWS[m].some(([v]) => v === view)) lastView[m] = view;
  if (m !== S.mode) {
    S.mode = m;
    try { localStorage.setItem('mode', m); } catch { /* blocked storage */ }
    document.documentElement.classList.toggle('engmode', m === 'eng');
    rereadTokens();
    $('#views').innerHTML = VIEWS[m].map(([v, n]) => `<button data-view="${v}">${esc(n)}</button>`).join('');
  }
  $$('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
}
function go(view, arg) {
  setMode(view);
  lab.unmountHrLab(); mhrView.unmountMhr(); unmountRuns();
  live.unmountLive(); mon.unmountMonitor(); tl.unmountTimeline(); wiz.unmountWizard(); ses.unmountSession(); eng.unmountEng(); cmp.unmountCompare();
  S.view = view; S.noAutoRecord = view === 'wizard';
  const box = document.createElement('div');
  $('#main').replaceChildren(box);
  if (view === 'live') live.mountLive(box, (id) => go('monitor', id), planCtx);
  else if (view === 'monitor') mon.mountMonitor(box, arg, () => go('live'));
  else if (view === 'timeline') tl.mountTimeline(box);
  else if (view === 'plan') planView.mountPlan(box, planCtx);
  else if (view === 'eng') eng.mountEng(box, { radio: () => simRadio, openMonitor: (id) => go('monitor', id) });
  else if (view === 'compare') cmp.mountCompare(box);
  else if (view === 'hrlab') lab.mountHrLab(box);
  else if (view === 'mhr') mhrView.mountMhr(box);
  else if (view === 'runs') mountRuns(box, { folder: () => (S.folder.permission === 'granted' ? S.folder.handle : null), config: () => S.mhr, maxHr: (id) => maxHrFor(id), upload: (run) => sendRunToPc(run) });
  else if (view === 'wizard') wiz.mountWizard(box, { W, save: (w) => kvSet('wizard', w), pickFolder: wizardPick, createListHere, connectTest: () => connect(null), startSession: () => go(S.session ? 'live' : 'home') });
  else if (view === 'checklist') ses.mountChecklist(box, ctx);
  else if (view === 'end') ses.mountEnd(box, ctx);
  else ses.mountHome(box, ctx);
  $$('#views [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view || (view === 'monitor' && b.dataset.view === 'live'))));
  banners();
}

function onChange(what) {
  if (what === 'links' || what === 'registry') { fillTargets(); if (S.view === 'live') live.rebuild(); }
  if (what === 'link' && !S.session && !S.noAutoRecord && [...S.links.values()].some((e) => e.linkState?.state === 'streaming')) {
    toast('Sensor connected. Recording started.');
    startSession('session');
  }
}

// ---------- sessions ----------
async function startSession(label) {
  if (S.session) { go('live'); return; }
  if (S.sim && !label.startsWith('sim')) label = `sim-${label}`; // simulated sessions are named as such, wherever they are saved
  const drive = S.folder.permission === 'granted' ? S.folder.handle : null;
  S.session = { label, startPerf: performance.now(), startUnix: Date.now(), name: null };
  S.marks = []; S.gaps = []; S.hiddenWhileRecording = false; S.plan = null; S.phases = [];
  for (const e of S.links.values()) { e.data = newData(); e.ppgFilters = null; e.mhr = null; e.mhrLast = null; e.pcHr = null; e.moveAcc = null; if (e.linkState?.state === 'streaming') e.streamingSince = now(); }
  const pc = await kvGet('pcUpload').catch(() => null);
  const live = pc?.token && pc.live !== false ? { url: pc.url, token: pc.token } : null; // live copy to the PC (core/storage/live.js)
  S.live = live ? { state: 'starting' } : null;
  worker.postMessage({ type: 'session-start', label, startedUnixMs: S.session.startUnix, drive, app: appInfo(), registry: S.sim ? null : S.reg, checkpointS: CKPT_S, live });
  wake.start();
  log('info', `session started: ${label}`);
  go('live');
}

// ---------- training plan ----------
// Every phase change goes into annotations.json with its target zones and the newest sample index
// of every stream: ready made labels for training coaching models.
function planMark(extra, t) {
  worker.postMessage({ type: 'mark', mark: { t, wall: new Date().toISOString(), target: 'all', target_name: 'all athletes', plan: S.plan?.name, ...extra } });
}
function enterPhase(p, at) {
  const open = S.phases.at(-1); if (open && open.to == null) open.to = at;
  S.phases.push({ from: at, to: null, name: p.name, zone: p.zone });
  planMark({ kind: 'phase', label: 'Phase', text: `${p.name}, target ${planView.zoneText(p.zone).toLowerCase()}`, phase_index: p.index, target_zones: p.zone, planned_s: Number.isFinite(p.s) ? p.s : null }, at);
}
async function startPlan(plan) {
  if (!S.session) await startSession(plan.name.toLowerCase());
  if (S.plan) stopPlan(true);
  const t = now();
  S.plan = startRun(plan, t);
  planMark({ kind: 'plan', label: 'Plan', text: `${plan.name} started` }, t);
  enterPhase({ ...S.plan.phases[0], index: 0 }, t);
  toast(`${plan.name} started. ${S.plan.phases[0].name}: target ${planView.zoneText(S.plan.phases[0].zone).toLowerCase()}.`);
  go('live');
}
function tickPlan(t) {
  if (!S.plan || S.plan.finishedLogged) return;
  for (const p of advance(S.plan, t)) enterPhase(p, p.at);
  if (S.plan.done) {
    S.plan.finishedLogged = true;
    const open = S.phases.at(-1); if (open && open.to == null) open.to = S.plan.phaseStart;
    planMark({ kind: 'plan', label: 'Plan', text: `${S.plan.name} finished` }, S.plan.phaseStart);
    toast(`${S.plan.name} finished.`);
  }
}
function nextPhase() { if (!S.plan) return; for (const p of skip(S.plan, now())) enterPhase(p, p.at); tickPlan(now()); }
function stopPlan(quiet = false) {
  if (!S.plan) return;
  const t = now(), open = S.phases.at(-1);
  if (open && open.to == null) open.to = t;
  if (!S.plan.finishedLogged) planMark({ kind: 'plan', label: 'Plan', text: `${S.plan.name} stopped` }, t);
  if (!quiet) toast(`${S.plan.name} stopped.`);
  S.plan = null;
}

/** One click demo: start a session and connect every simulated sensor, no popups. */
async function runDemo() {
  await startSession('demo');
  for (const id of S.reg.sensors.map((s) => s.deviceId)) { connectSim(id); await new Promise((r) => setTimeout(r, 400)); }
}

async function endSession() {
  if (!S.session) return;
  const yes = await modal(`<h2>End this session?</h2><p>Sensors disconnect and the recording is saved to the Sa7a folder.</p>
    <div class="foot"><button class="btn primary" data-y>End session</button><button class="btn" data-n>Keep recording</button></div>`, (d, close) => {
    d.querySelector('[data-y]').addEventListener('click', () => close(true));
    d.querySelector('[data-n]').addEventListener('click', () => close(false));
  });
  if (!yes) return;
  toast('Saving the session. This takes a few seconds.', 8000);
  if (S.plan) stopPlan(true);
  await disconnectAll();
  const summary = await ask({ type: 'session-end' }, 'ended');
  S.summary = summary; S.session = null; wake.stop();
  for (const e of S.links.values()) e.data = newData();
  log('info', `session ended: ${JSON.stringify(summary)}`);
  go('end');
  const pc = await kvGet('pcUpload').catch(() => null);
  if (pc?.auto && pc.token && summary?.name) sendToPc(summary.name, 'folder').catch(() => {});
}

// ---------- to the PC over Tailscale (core/storage/upload.js, tools/receive.mjs) ----------
/** Address and token of the PC receiver, kept on this device only. Asks when there is none yet. */
async function pcSettings(force = false) {
  const cur = (await kvGet('pcUpload').catch(() => null)) || { url: 'https://fenan-desktop.tailcbb45a.ts.net:8447', token: '', auto: true, live: true };
  if (cur.token && !force) return cur;
  const got = await modal(`<h2>Send recordings to the PC</h2>
    <p class="dim">Over Tailscale to tools/receive.mjs on the PC. Copy the token from tools/receive.token on the PC; it stays on this device.</p>
    <label class="field">PC address<input data-u value="${esc(cur.url)}" autocomplete="off"></label>
    <label class="field">Token<input data-t type="password" value="${esc(cur.token)}" autocomplete="off"></label>
    <label class="inline"><input type="checkbox" data-a ${cur.auto ? 'checked' : ''}> Send every session when it ends</label>
    <label class="inline"><input type="checkbox" data-l ${cur.live !== false ? 'checked' : ''}> Stream live to the PC while recording</label>
    <div class="foot"><button class="btn primary" data-y>Save</button><button class="btn" data-x>Cancel</button></div>`, (d, close) => {
    d.querySelector('[data-y]').addEventListener('click', () => close({ url: d.querySelector('[data-u]').value.trim(), token: d.querySelector('[data-t]').value.trim(), auto: d.querySelector('[data-a]').checked, live: d.querySelector('[data-l]').checked }));
    d.querySelector('[data-x]').addEventListener('click', () => close(null));
  });
  if (!got) return null;
  await kvSet('pcUpload', got).catch(() => toast('Not saved on this device; used for this send only.'));
  return got;
}

/** A run from Past runs: its own parent folder (device working copy or save folder). */
async function sendRunToPc(run) {
  const pc = await pcSettings(); if (!pc?.token) return null;
  try {
    const r = await uploadSession(run.parent, run.name, { url: pc.url, token: pc.token });
    toast(`Sent to the PC: ${r.where}`, 7000);
    return r;
  } catch (e) { toast(`Not sent to the PC (${e.stage || 'error'}): ${e.message}`, 12000); throw e; }
}

/** One session to the PC. source 'folder': the save folder (holds the finished zip); 'device': this device's working copy. */
async function sendToPc(name, source = 'folder') {
  const pc = await pcSettings(); if (!pc?.token) return null;
  try {
    const dir = source === 'folder' && S.folder.permission === 'granted' ? S.folder.handle : await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions');
    toast(`Sending ${name} to the PC…`, 8000);
    const r = await uploadSession(dir, name, { url: pc.url, token: pc.token });
    toast(`Sent to the PC: ${r.where}`, 7000);
    return r;
  } catch (e) { toast(`Not sent to the PC (${e.stage || 'error'}): ${e.message}`, 12000); log('error', `upload ${name}: ${e.message}`); throw e; }
}

function addMark(label) {
  if (!S.session) { toast('Start a session first. Events are saved with the recording.'); return; }
  const target = $('#mTarget').value, text = $('#mNote').value.trim(), t = now();
  const who = target === 'all' ? 'all athletes' : S.reg.athletes.find((a) => a.id === target)?.name || 'one athlete';
  $('#mNote').value = '';
  S.marks.push({ t, label, text, target });
  worker.postMessage({ type: 'mark', mark: { t, wall: new Date().toISOString(), label, text, target, target_name: who } });
  toast(T.marks.saved(text ? `${label} "${text}"` : label, fmtMS(t), who));
}

// ---------- folder ----------
async function folderReady() {
  try { S.folder.shared = await isSharedFolder(S.folder.handle); } catch { S.folder.shared = null; }
  if (!S.sim) { const r = await loadRegistry(S.folder.handle); S.reg = r.reg; S.regSource = r.source; }
  worker.postMessage({ type: 'drive', drive: S.folder.handle });
  worker.postMessage({ type: 'recover' });
  emit('registry');
}

async function allowSavingClick() {
  if (!S.folder.handle) { go('wizard'); return; }
  try {
    if (await allowSaving(S.folder.handle)) { S.folder.permission = 'granted'; await folderReady(); toast('Saving to your Sa7a folder again.'); }
    else toast(say(T.errors.folderLost));
  } catch (e) { log('error', `allow saving: ${e.message}`); toast(say(e.name === 'NotFoundError' ? T.errors.folderGone : T.errors.folderLost)); }
  banners();
}

async function wizardPick() {
  let h;
  try { h = await pickFolder(); } catch (e) { toast(`Chrome would not open that folder (${e.message}). Pick the Sa7a folder in Google Drive.`); return null; }
  if (!h) return null;
  S.folder = { handle: h, name: h.name, permission: 'granted', shared: null };
  let writeOk = false;
  try { writeOk = await writeTest(h); } catch (e) { log('error', `write test: ${e.message}`); }
  await folderReady();
  return { writeOk };
}

async function createListHere() {
  if (S.folder.permission !== 'granted') return;
  await saveRegistry(S.folder.handle, S.reg);
  S.folder.shared = true;
}

function storeClick() {
  if (!S.folder.handle) { go('wizard'); return; }
  if (S.folder.permission !== 'granted') { allowSavingClick(); return; }
  if (S.storage?.drive === 'error') toast(`${S.storage.driveError}. Recording is safe on this Mac. Open Help if it keeps happening.`, 8000);
  else toast(S.folder.shared === false ? T.storage.localOnly : `Saving to ${S.folder.name}.`);
}

// ---------- worker ----------
function onWorker(e) {
  const m = e.data;
  if (m.type === 'display') { const x = S.links.get(m.id); if (x) ingest(x, m); return; }
  if (pending.has(m.type)) { const p = pending.get(m.type); pending.delete(m.type); p.resolve(m.summary ?? m.bundle ?? m.blob ?? m); return; }
  switch (m.type) {
    case 'storage': S.storage = m.status; break;
    case 'live': {
      if (m.status.state === 'stopped' && S.live?.state !== 'stopped') { toast(`Live copy to the PC stopped: ${m.status.error}`, 10000); log('warn', `live: ${m.status.error}`); }
      S.live = m.status; break;
    }
    case 'session': if (S.session) S.session.name = m.name; break;
    case 'gap': S.gaps.push({ id: m.id, from: m.from, to: m.to, text: `gap ${(m.to - m.from).toFixed(1)} s, not filled in` }); break;
    case 'recovered': { const ok = m.sessions.filter((s) => s.drive); if (ok.length) toast(`Recovered ${ok.length} session${ok.length > 1 ? 's' : ''} the app did not close, and saved ${ok.length > 1 ? 'them' : 'it'} to ${S.folder.name}.`, 8000); break; }
    case 'log': log(m.level, m.msg); if (S.debug) console.log('[worker]', m.level, m.msg); break;
    case 'error':
      log('error', `${m.about}: ${m.message}`);
      if (m.about === 'session-start') toast(`Recording could not start (${m.message}). Reload the page and try again.`, 10000);
      { const reply = { 'session-end': 'ended', bundle: 'bundle', download: 'download' }[m.about], p = reply && pending.get(reply);
        if (p) { pending.delete(reply); if (reply === 'ended') p.resolve({ drive: false, reason: m.message }); else p.reject(new Error(m.message)); } }
      break;
    default: break;
  }
}

// ---------- link gaps (for the timeline) ----------
function trackLinkGaps() {
  for (const e of S.links.values()) {
    const st = e.linkState?.state, open = S.gaps.find((g) => g.id === e.id && g.link && g.to == null);
    if (st === 'reconnecting' && !open && S.session) S.gaps.push({ id: e.id, from: now(), to: null, link: true, text: 'Reconnecting' });
    if (st === 'streaming' && open) { open.to = now(); open.text = `link lost ${(open.to - open.from).toFixed(0)} s, not filled in`; }
  }
}

// ---------- header, banners, loops ----------
function header(t) {
  const rec = $('#rec'), on = !!S.session;
  rec.classList.toggle('idle', !on);
  $('#clock').textContent = on ? fmtClock(t) : '00:00:00';
  $('#recl').textContent = on ? 'RECORDING' : 'NOT RECORDING';
  $('#bEnd').hidden = !on;
  $('#events').setAttribute('aria-disabled', String(!on));
  const st = S.storage, f = S.folder, store = $('#store');
  let cls = '', name = f.name || 'Sa7a Drive', txt;
  if (!f.handle) { cls = 'warn'; name = 'No save folder'; txt = 'Open Setup'; }
  else if (f.permission !== 'granted') { cls = 'warn'; txt = 'Click to allow saving'; }
  else if (st?.local === 'error' || st?.drive === 'error') { cls = 'bad'; txt = st.local === 'error' ? 'Saving failed' : 'Drive copy failed'; }
  else if (on && st?.lastLocalWrite) { const s = Math.max(0, Math.round((Date.now() - st.lastLocalWrite) / 1000)); txt = s <= 1 ? 'Saved just now' : `Saved ${s} s ago`; if (s > 5) cls = 'bad'; }
  else txt = f.shared === false ? 'This Mac only' : 'Ready';
  const lv = on && S.live;
  if (lv) txt += lv.state === 'ok' ? ' · PC live' : lv.state === 'behind' ? ` · PC ${(lv.behind / 1048576).toFixed(1)} MB behind` : lv.state === 'stopped' ? ' · PC live stopped' : lv.state === 'error' ? ' · PC not reached' : '';
  store.className = `store ${cls}`;
  store.title = lv?.error || '';
  $('#storeName').textContent = name; $('#storeTxt').textContent = txt;
}

let lastBanners = '';
function banners() {
  const list = [];
  if (S.demo) list.push(['', 'Demo with simulated sensors. Nothing on this page talks to a real sensor yet.', `<span class="seg" role="group" aria-label="Number of sensors">${[1, 2, 4, 10].map((n) => `<a class="btn quiet" style="border:0;min-height:36px" href="?sim=${n}" aria-current="${n === S.sim}">${n} sensor${n > 1 ? 's' : ''}</a>`).join('')}</span>`]);
  if (S.update) list.push(['', S.session ? T.update.inSession : T.update.idle, S.session ? '' : `<button class="btn primary" data-b="reload">${T.update.reload}</button>`]);
  if (S.folder.handle && S.folder.permission === 'prompt') list.push(['warn', 'Saving to the Sa7a folder is paused until you allow it.', `<button class="btn primary" data-b="allow">${T.storage.allow}</button><span class="dim">${T.storage.allowHint}</span>`]);
  if (!S.sim && !S.bluetooth) list.push(['bad', say(T.errors.btOff), '']);
  if (S.hiddenWhileRecording) list.push(['warn', say(T.errors.tabHidden), '<button class="btn" data-b="dismiss-hidden">OK</button>']);
  if (S.degraded) list.push(['warn', S.degraded, '']);
  if (S.session && S.folder.permission === 'granted' && S.folder.shared === false) list.push(['warn', T.storage.localOnly, '<button class="btn" data-b="setup">Open Setup</button>']);
  const html = list.map(([cls, text, extra]) => `<div class="banner ${cls}">${ICO.info}<span class="grow">${esc(text)}</span>${extra}</div>`).join('');
  if (html === lastBanners) return;
  lastBanners = html;
  const box = $('#banners'); box.innerHTML = html;
  box.querySelector('[data-b="reload"]')?.addEventListener('click', () => reloadFresh(S.update));
  box.querySelector('[data-b="allow"]')?.addEventListener('click', allowSavingClick);
  box.querySelector('[data-b="dismiss-hidden"]')?.addEventListener('click', () => { S.hiddenWhileRecording = false; banners(); });
  box.querySelector('[data-b="setup"]')?.addEventListener('click', () => go('wizard'));
}

// Warn when adding sensors starts to cost data: any sensor losing over 2 % in the last minute
// while three or more stream.
const lossHist = new Map();
function checkDegraded() {
  const t = now(), streaming = [...S.links.values()].filter((e) => ['ok', 'raw'].includes(slotState(e, t)));
  let worst = null;
  for (const e of streaming) {
    const lost = Object.values(e.stats || {}).reduce((a, s) => a + (s.lost || 0), 0), n = Object.values(e.stats || {}).reduce((a, s) => a + (s.samples || 0), 0);
    const h = lossHist.get(e.id) || []; h.push([t, lost, n]); while (h.length && h[0][0] < t - 60) h.shift(); lossHist.set(e.id, h);
    const dl = lost - h[0][1], dn = (n - h[0][2]) + dl, pct = dn > 0 ? dl / dn : 0;
    if (pct > 0.02 && (!worst || pct > worst.pct)) worst = { id: e.id, pct };
  }
  const was = S.degraded;
  S.degraded = streaming.length >= 3 && worst ? `Bluetooth is losing data with ${streaming.length} sensors connected (${(worst.pct * 100).toFixed(1)}% lost on ${worst.id.slice(-4)} in the last minute). If it continues, disconnect one sensor.` : false;
  if (S.degraded !== was) { if (S.degraded) log('warn', S.degraded); banners(); }
}

function tick() {
  const t = now();
  header(t);
  trackLinkGaps();
  tickPlan(t);
  if (S.view === 'live') live.refresh(t);
  else if (S.view === 'monitor') mon.refreshMonitor(t);
  else if (S.view === 'timeline') tl.refreshTimeline(t);
  else if (S.view === 'plan') planView.refreshPlan(t);
  else if (S.view === 'eng') eng.refreshEng(t);
  else if (S.view === 'compare') cmp.refreshCompare(t);
  else if (S.view === 'hrlab') lab.refreshHrLab(t);
  else if (S.view === 'wizard') wiz.refreshWizard();
  else ses.refreshSession();
  banners();
}

function frame() {
  const t = now();
  if (S.view === 'live') live.drawFrame(t);
  else if (S.view === 'monitor') mon.drawMonitor(t);
  else if (S.view === 'eng') eng.drawEng(t);
  else if (S.view === 'hrlab') lab.drawHrLab(t);
  else if (S.view === 'mhr') mhrView.drawMhr(t);
  requestAnimationFrame(frame);
}

// ---------- files out ----------
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function download(name) {
  if (!name) return;
  toast('Preparing the download.');
  try { const blob = await ask({ type: 'download', name }, 'download'); saveBlob(blob, `${name}.zip`); toast(`Downloaded ${name}.zip. ${T.end.dragHow}`, 12000); }
  catch (e) { toast(`The download could not be made (${e.message}).`); }
}

async function debugBundle() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `sa7a_debug_${stamp}`;
  const wb = await ask({ type: 'bundle' }, 'bundle');
  let hi = null; try { hi = await navigator.userAgentData?.getHighEntropyValues?.(['platformVersion', 'model', 'fullVersionList', 'architecture']); } catch { /* not offered */ }
  const env = { app: appInfo(), browser: S.env, userAgentData: hi, screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, viewport: [innerWidth, innerHeight] },
    bluetooth: S.bluetooth, wakeLock: S.wake, folder: { name: S.folder.name, permission: S.folder.permission, shared: S.folder.shared }, storage: S.storage, session: S.session, time: new Date().toISOString() };
  const links = [...S.links.values()].map((e) => ({ id: e.id, mode: e.mode, state: e.linkState, streams: e.streams, stats: e.stats, log: e.link.log }));
  const files = [
    ['env.json', JSON.stringify(env, null, 1)], ['app-log.json', JSON.stringify(S.logs, null, 1)], ['sensors.json', JSON.stringify(links, null, 1)],
    ['worker.json', JSON.stringify({ env: wb.env, log: wb.workerLog }, null, 1)], ['raw-packets-last-60s.csv', wb.rawCsv], ['manifest.json', JSON.stringify(wb.manifest, null, 1)],
  ].map(([n, s]) => ({ name: `${base}/${n}`, source: s }));
  const blob = await zipToBlob(files), name = `${base}.zip`;
  if (S.folder.permission === 'granted') {
    try {
      const w = await (await S.folder.handle.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob); await w.close();
      toast(T.help.bundleSaved(name, `your ${S.folder.name} folder`), 12000); return;
    } catch (e) { log('error', `bundle to folder: ${e.message}`); }
  }
  saveBlob(blob, name);
  toast(T.help.bundleSaved(name, 'your Downloads folder'), 12000);
}
