// Help drawer: searchable, one fix per entry, and the "Send this to Mohammad" debug bundle.
import T from '../../strings/en.js';
import { el, esc, $, toast } from '../ui.js';

let drawer = null;
export function openHelp(onBundle) {
  if (!drawer) {
    drawer = el(`<aside class="drawer" aria-label="${T.help.title}"><div class="drawer-h"><h2>${T.help.title}</h2><button class="btn" data-close>Close</button></div>
      <div class="drawer-s"><input placeholder="${T.help.search}" aria-label="${T.help.search}" autocomplete="off"></div><div class="drawer-b"></div></aside>`);
    document.body.append(drawer);
    drawer.querySelector('[data-close]').addEventListener('click', closeHelp);
    drawer.querySelector('input').addEventListener('input', (e) => render(e.target.value, onBundle));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer && !drawer.hidden) closeHelp(); });
  }
  drawer.hidden = false;
  render('', onBundle);
  drawer.querySelector('input').focus();
}
export function closeHelp() { if (drawer) drawer.hidden = true; }

function render(q, onBundle) {
  q = q.trim().toLowerCase();
  const items = T.help.entries.filter(([a, b]) => !q || `${a} ${b}`.toLowerCase().includes(q));
  const body = drawer.querySelector('.drawer-b');
  body.innerHTML = (items.length ? items.map(([a, b], i) => `<details class="hitem"${q && i === 0 ? ' open' : ''}><summary>${esc(a)}</summary><p>${esc(b)}</p></details>`).join('') : `<p class="dim">${T.help.none}</p>`)
    + `<div class="contact"><h3>${T.help.contactTitle}</h3><p class="dim">${T.help.contactBody}</p><button class="btn primary" data-bundle>${T.help.contactButton}</button></div>`;
  $('[data-bundle]', body).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await onBundle(); } catch (err) { toast(`The debug file could not be made (${err.message}). Take a screenshot of this page and send that instead.`); }
    e.target.disabled = false;
  });
}
