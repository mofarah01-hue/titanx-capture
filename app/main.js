// TitanX Capture: boot, routing, sessions, events, storage status. Everything the remote user sees
// starts here. URL options: ?sim=N fakes N sensors, ?setup=reset clears saved settings (never
// recordings), ?debug=1 logs every raw packet to the console.
import T from '../strings/en.js';
import { VERSION, BUILT } from '../core/version.js';
import { browserCheck, watchBluetooth, createWakeLock, watchForUpdates, reloadFresh } from '../core/platform.js';
import { folderState, pickFolder, allowSaving, writeTest, isSharedFolder } from '../core/storage/folder.js';
import { kvGet, kvSet, kvClear } from '../core/storage/kv.js';
import { loadRegistry, saveRegistry, emptyRegistry, upsertAthlete, upsertSensor } from '../core/registry.js';
import { SimRadio, SIM_IDS } from '../core/sim/fake-sensor.js';
import { zipToBlob } from '../core/storage/zip.js';
import { S, bus, emit, now, ingest, newData, log, athletesInView, slotState } from './state.js';
import { initLinks, connect, disconnectAll } from './links.js';
import { readTokens } from './draw.js';
import { ICO, EVENTS, esc, el, $, $$, toast, say, modal, fmtClock, fmtMS } from './ui.js';
import * as live from './views/live.js';
import * as mon from './views/monitor.js';
import * as tl from './views/timeline.js';
import * as wiz from './views/wizard.js';
import * as ses from './views/session.js';
import { openHelp } from './views/help.js';

const params = new URLSearchParams(location.search);
S.sim = Math.max(0, Math.min(7, parseInt(params.get('sim') || '0', 10) || 0));
S.debug = params.get('debug') === '1';
const CKPT_S = parseInt(params.get('ckpt') || '', 10) || undefined; // tests only: Drive copy interval in seconds (default 300)

let worker, wake, W = {};
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
  shell();
  readTokens();
  worker = new Worker(new URL('../core/capture-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => { log('error', `worker: ${e.message}`); toast('The recorder stopped working. Reload the page; everything saved so far is kept.'); };
  worker.postMessage({ type: 'init', debug: S.debug });
  wake = createWakeLock((on) => { S.wake = on; });

  let radio = null;
  if (S.sim) { radio = new SimRadio(S.sim); seedSimRegistry(); S.bluetooth = true; }
  else watchBluetooth((on) => { S.bluetooth = on; banners(); });
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
  watchForUpdates(VERSION, (info) => { S.update = info; banners(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.session) { S.hiddenWhileRecording = true; log('warn', 'window hidden during a session'); } banners(); });
  bus.addEventListener('change', (e) => onChange(e.detail));
  setInterval(tick, 250);
  setInterval(checkDegraded, 5000);
  requestAnimationFrame(frame);
  go(W.done || S.sim ? 'home' : 'wizard');
}

function gate(env) {
  const msg = !window.isSecureContext ? T.gate.notSecure : env.tooOld ? T.gate.oldChrome(env.major) : T.gate.why(env.name);
  document.body.innerHTML = `<div class="gate"><div class="card"><span class="eyebrow">TITAN X CAPTURE</span><h2>${T.gate.title}</h2><p>${esc(msg)}</p>
    <div class="foot" style="border:0;padding:0"><a class="btn primary big" href="https://www.google.com/chrome/" target="_blank" rel="noopener">${T.gate.download}</a><button class="btn" id="cp">${T.gate.copyLink}</button></div><p class="dim">${T.gate.after}</p></div></div>`;
  $('#cp').addEventListener('click', () => navigator.clipboard?.writeText(location.href).then(() => toast('Address copied.'), () => toast(location.href, 10000)));
}

function seedSimRegistry() {
  const people = [['Amir Hassan', 190, 'left_ear'], ['Kareem Saleh', 197, 'right_ear'], ['Omar Nasser', 192, 'forehead'], ['Omar Nasser', 192, 'back_of_head'], ['Yusuf Adel', 198, 'left_ear'], ['Bilal Farouk', 203, 'right_ear'], ['Tariq Mansour', null, 'forehead']];
  const reg = emptyRegistry();
  for (let i = 0; i < S.sim; i++) {
    const [name, maxHr, position] = people[i];
    const a = reg.athletes.find((x) => x.name === name) || upsertAthlete(reg, { name, maxHr });
    upsertSensor(reg, SIM_IDS[i], { athleteId: a.id, position, mode: i === 3 ? 'max' : 'polar' });
  }
  S.reg = reg; S.regSource = 'sim';
}

// ---------- shell ----------
function shell() {
  document.body.innerHTML = '';
  document.body.append(el(`<div class="app">
    <header class="top">
      <div class="brand"><span class="tx">TITAN X</span><span class="sep"></span><span class="sub">SA7A LABS</span>${S.sim ? '<span class="simtag">SIMULATED</span>' : ''}
        <span class="views" role="group" aria-label="View"><button data-view="live">Live</button><button data-view="timeline">Timeline</button></span></div>
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
  $$('.views [data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
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
const ctx = {
  toChecklist: () => (S.session ? go('live') : go('checklist')),
  home: () => go('home'),
  startSession: (label) => startSession(label),
  download: (name) => download(name),
  allowSaving: () => allowSavingClick(),
  openSetup: () => go('wizard'),
};
function go(view, arg) {
  live.unmountLive(); mon.unmountMonitor(); tl.unmountTimeline(); wiz.unmountWizard(); ses.unmountSession();
  S.view = view; S.noAutoRecord = view === 'wizard';
  const box = document.createElement('div');
  $('#main').replaceChildren(box);
  if (view === 'live') live.mountLive(box, (id) => go('monitor', id));
  else if (view === 'monitor') mon.mountMonitor(box, arg, () => go('live'));
  else if (view === 'timeline') tl.mountTimeline(box);
  else if (view === 'wizard') wiz.mountWizard(box, { W, save: (w) => kvSet('wizard', w), pickFolder: wizardPick, createListHere, connectTest: () => connect(null), startSession: () => go(S.session ? 'live' : 'checklist') });
  else if (view === 'checklist') ses.mountChecklist(box, ctx);
  else if (view === 'end') ses.mountEnd(box, ctx);
  else ses.mountHome(box, ctx);
  $$('.views [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view || (view === 'monitor' && b.dataset.view === 'live'))));
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
  const drive = S.folder.permission === 'granted' ? S.folder.handle : null;
  S.session = { label, startPerf: performance.now(), startUnix: Date.now(), name: null };
  S.marks = []; S.gaps = []; S.hiddenWhileRecording = false;
  for (const e of S.links.values()) { e.data = newData(); e.ppgFilter = null; e.moveAcc = null; if (e.linkState?.state === 'streaming') e.streamingSince = now(); }
  worker.postMessage({ type: 'session-start', label, startedUnixMs: S.session.startUnix, drive, app: appInfo(), registry: S.sim ? null : S.reg, checkpointS: CKPT_S });
  wake.start();
  log('info', `session started: ${label}`);
  go('live');
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
  await disconnectAll();
  const summary = await ask({ type: 'session-end' }, 'ended');
  S.summary = summary; S.session = null; wake.stop();
  for (const e of S.links.values()) e.data = newData();
  log('info', `session ended: ${JSON.stringify(summary)}`);
  go('end');
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
  store.className = `store ${cls}`;
  $('#storeName').textContent = name; $('#storeTxt').textContent = txt;
}

let lastBanners = '';
function banners() {
  const list = [];
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
  if (S.view === 'live') live.refresh(t);
  else if (S.view === 'monitor') mon.refreshMonitor(t);
  else if (S.view === 'timeline') tl.refreshTimeline(t);
  else if (S.view === 'wizard') wiz.refreshWizard();
  else ses.refreshSession();
  banners();
}

function frame() {
  const t = now();
  if (S.view === 'live') live.drawFrame(t);
  else if (S.view === 'monitor') mon.drawMonitor(t);
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
