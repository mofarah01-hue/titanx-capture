// Setup wizard: eight steps, one per screen. Every step the app can check, it checks by itself.
import T from '../../strings/en.js';
import { S, liveHr, now } from '../state.js';
import { TICK, WARN, TODO, esc, setHTML, $, $$, toast } from '../ui.js';

const STEPS = T.wizard.steps;
let root = null, ctx = null, cur = 0;

/** ctx: { W (saved progress), save(W), pickFolder(), createListHere(), connectTest(), startSession() } */
export function mountWizard(container, c) {
  root = container; ctx = c;
  cur = Math.max(0, STEPS.findIndex((s) => status(s.key) !== 'done'));
  if (cur < 0) cur = STEPS.length - 1;
  root.innerHTML = `<div class="page wiz"><ol class="wsteps" data-k="list"></ol><div class="card" data-k="card"></div></div>`;
  renderCard();
  refreshWizard();
}

function status(key) {
  const W = ctx.W;
  switch (key) {
    case 'chrome': return S.env.ok ? 'done' : 'todo';
    case 'bookmark': return W.bookmark ? 'done' : 'todo';
    case 'bluetooth': return S.bluetooth ? 'done' : 'todo';
    case 'drive': case 'shared': return S.folder.shared ? 'done' : 'todo';
    case 'folder': return S.folder.permission === 'granted' && W.writeOk ? (S.folder.shared ? 'done' : 'warn') : 'todo';
    case 'sensor': return W.hrSeen ? 'done' : 'todo';
    default: return W.done ? 'done' : 'todo';
  }
}

export function refreshWizard() {
  if (!root) return;
  for (const e of S.links.values()) { const hr = liveHr(e, now()); if (hr != null && !ctx.W.hrSeen) { ctx.W.hrSeen = true; ctx.W.hr = hr; ctx.save(ctx.W); renderCard(); } }
  setHTML($('[data-k="list"]', root), STEPS.map((s, i) => {
    const st = status(s.key);
    return `<li><button class="wstep ${st === 'done' ? 'done' : ''} ${i === cur ? 'cur' : ''}" data-i="${i}"><span class="n">${st === 'done' ? '✓' : i + 1}</span><span><b>${esc(s.title)}</b><small>${st === 'done' ? 'Done' : st === 'warn' ? 'Check the warning' : i === cur ? 'You are here' : ''}</small></span></button></li>`;
  }).join(''));
  $$('[data-i]', root).forEach((b) => { b.onclick = () => { cur = +b.dataset.i; renderCard(); refreshWizard(); }; });
  const live = $('[data-k="live"]', root);
  if (live) setHTML(live, liveLine());
}

function liveLine() {
  const s = STEPS[cur];
  if (s.key === 'bluetooth') return S.bluetooth ? `${TICK}<span>${s.ok}</span>` : `${WARN}<span>${s.off}</span>`;
  if (s.key === 'sensor') {
    if (ctx.W.hrSeen) return `${TICK}<span>${s.ok(ctx.W.hr)}</span>`;
    const any = [...S.links.values()].some((e) => e.linkState?.state === 'streaming');
    return any ? `${TODO}<span>${s.waiting}</span>` : '';
  }
  if (s.key === 'chrome') return `${TICK}<span>${s.ok}</span>`;
  return '';
}

function renderCard() {
  const s = STEPS[cur], card = $('[data-k="card"]', root);
  let extra = '';
  if (s.key === 'bookmark') extra = `<p><span class="kbd">Cmd</span> + <span class="kbd">D</span></p><label class="check"><input type="checkbox" data-k="bm" ${ctx.W.bookmark ? 'checked' : ''}><span>${s.tick}</span></label>`;
  if (s.key === 'drive') extra = `<p><a class="btn" href="https://www.google.com/drive/download/" target="_blank" rel="noopener">${s.link}</a></p><p class="dim">${s.ok}</p>`;
  if (s.key === 'shared') extra = `<p><b>${s.why}</b></p><p><a class="btn" href="https://drive.google.com/drive/shared-with-me" target="_blank" rel="noopener">Open Shared with me</a></p><p class="dim">${s.ok}</p>`;
  if (s.key === 'folder') extra = `<p>${s.how}</p><div><button class="btn primary" data-pick>${s.button}</button></div><ul class="checks" data-k="checks">${folderChecks(s)}</ul>`;
  if (s.key === 'sensor') extra = `<div><button class="btn primary" data-connect>${s.button}</button></div>`;
  if (s.key === 'ready') extra = `<div><button class="btn primary big" data-start>${s.button}</button></div>`;
  card.innerHTML = `<span class="eyebrow">${T.wizard.stepOf(cur + 1, STEPS.length).toUpperCase()}</span><h2>${esc(s.title)}</h2><p>${esc(s.body)}</p>${extra}
    <p class="hint" data-k="live" style="align-items:center;gap:10px"></p>
    <div class="foot"><button class="btn" data-back ${cur === 0 ? 'disabled' : ''}>${T.wizard.back}</button><span class="spacer"></span>${cur < STEPS.length - 1 ? `<button class="btn primary" data-next>${T.wizard.next}</button>` : ''}</div>`;
  card.querySelector('[data-back]').onclick = () => { cur = Math.max(0, cur - 1); renderCard(); refreshWizard(); };
  card.querySelector('[data-next]')?.addEventListener('click', () => { cur = Math.min(STEPS.length - 1, cur + 1); renderCard(); refreshWizard(); });
  card.querySelector('[data-k="bm"]')?.addEventListener('change', (e) => { ctx.W.bookmark = e.target.checked; ctx.save(ctx.W); refreshWizard(); });
  card.querySelector('[data-pick]')?.addEventListener('click', async () => {
    const r = await ctx.pickFolder();
    if (r) { ctx.W.writeOk = r.writeOk; ctx.save(ctx.W); }
    card.querySelector('[data-k="checks"]').innerHTML = folderChecks(s);
    refreshWizard();
  });
  card.querySelector('[data-connect]')?.addEventListener('click', () => ctx.connectTest());
  card.querySelector('[data-start]')?.addEventListener('click', () => { ctx.W.done = true; ctx.save(ctx.W); ctx.startSession(); });
  card.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-mkl]')) return;
    await ctx.createListHere();
    card.querySelector('[data-k="checks"]').innerHTML = folderChecks(s);
    toast('Athlete list created in this folder. The remote Mac will now recognise it.');
    refreshWizard();
  });
}

function folderChecks(s) {
  if (S.folder.permission !== 'granted' || !S.folder.handle) return '';
  const rows = [[TICK, `<b>${esc(s.chosen(S.folder.name))}</b>`], ctx.W.writeOk ? [TICK, s.writeOk] : [WARN, `<b class="warn">${s.writeFail}</b>`]];
  rows.push(S.folder.shared ? [TICK, s.sharedOk]
    : [WARN, `<b class="warn">${s.notShared}</b><br><span class="dim">Mohammad: if this is your own Sa7a folder, </span><button class="linkbtn" data-mkl>create the athlete list here</button>`]);
  return rows.map(([i, t]) => `<li class="check">${i}<span>${t}</span></li>`).join('');
}
export const unmountWizard = () => { root = null; };
