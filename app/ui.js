// Small DOM helpers, icons and formatting shared by every view.
import T from '../strings/en.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Build an element from an HTML string (one root). */
export function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

const I = (d, extra = '') => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
export const ICO = {
  heart: (c) => I('<path d="M12 20.5s-7.2-4.4-9.1-9.1A5 5 0 0 1 12 6.6a5 5 0 0 1 9.1 4.8c-1.9 4.7-9.1 9.1-9.1 9.1z" fill="currentColor" stroke="none"/>', ` style="color:${c}"`),
  pulse: I('<path d="M2 12h4l2.5-6 4 12 2.5-6H22"/>'),
  ppg: I('<path d="M2 13c2 0 2-6 4-6s2 10 4 10 2-8 4-8 2 5 4 5h4"/>'),
  acc: I('<path d="M12 13V3M12 13l8 5M12 13l-8 5"/><path d="M9.5 5.5 12 3l2.5 2.5"/>'),
  gyro: I('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/><circle cx="12" cy="12" r="2"/>'),
  mag: I('<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h3.5M14.5 7H18"/>'),
  heartline: I('<path d="M3 12h3l2-4 3 8 2-4h8"/>'),
  chev: I('<path d="M9 6l6 6-6 6"/>'),
  back: I('<path d="M15 6l-6 6 6 6"/>'),
  cloud: I('<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 11.4 3.4 3.4 0 0 0 7 18z"/>'),
  gear: I('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
  help: I('<circle cx="12" cy="12" r="9.5"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.6"/><path d="M12 16.8v.4"/>'),
  info: I('<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.3"/>'),
  bt: I('<path d="M7 7l10 10-5 4V3l5 4L7 17"/>'),
  still: I('<path d="M9 5v14M15 5v14" stroke-width="3"/>'),
  light: I('<circle cx="14.5" cy="4.5" r="2"/><path d="M8 21l3.2-5.4 3 2.4V22M11.2 15.6 10 10.8l4.2.9 2.8 3.3M10 10.8l-3.8 2"/>'),
  heavy: I('<path d="M3 9.5v5M6.2 7v10M17.8 7v10M21 9.5v5M6.2 12h11.6" stroke-width="2.4"/>'),
  adjusted: I('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.8M12 18.4v2.8M2.8 12h2.8M18.4 12h2.8M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2"/>'),
  wrong: I('<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>'),
  mark: I('<path d="M5.5 21V4M5.5 4h11.5l-2.2 4 2.2 4H5.5"/>'),
};
export const TICK = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="var(--ok)"/><path d="M6.5 11.3l3 3 6-6.3" fill="none" stroke="#03130D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const WARN = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2 L21 20 H1 Z" fill="var(--warn)"/><path d="M11 8v6" stroke="#1A1200" stroke-width="2.2" stroke-linecap="round"/><circle cx="11" cy="16.8" r="1.3" fill="#1A1200"/></svg>';
export const TODO = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--line2)" stroke-width="1.5"/></svg>';

// Events: quick buttons and their colours. Order and names come from the strings file.
export const EVENTS = [['ev-still', 'still'], ['ev-light', 'light'], ['ev-heavy', 'heavy'], ['ev-adj', 'adjusted'], ['ev-wrong', 'wrong'], ['ev-mark', 'mark']]
  .map(([color, icon], i) => ({ label: T.marks.quick[i], color, icon }));
export const eventColor = (label) => (EVENTS.find((e) => e.label === label)?.color || 'ev-mark');

/** Top down head with the four sensor positions; `on` lists the ones to highlight. */
export function headSVG(on, size) {
  const P = { forehead: [17, 8.5], back_of_head: [17, 29], left_ear: [5.6, 18.5], right_ear: [28.4, 18.5] };
  const dots = Object.entries(P).map(([k, [x, y]]) => `<circle cx="${x}" cy="${y}" r="${on.includes(k) ? 3.8 : 1.7}" class="${on.includes(k) ? 'on' : 'off'}"/>`).join('');
  return `<svg class="head" viewBox="0 0 34 36" width="${size}" height="${Math.round(size * 36 / 34)}" aria-hidden="true"><path class="nose" d="M17 1.6 L14.6 5.9 L19.4 5.9 Z"/><rect class="ear" x="3.6" y="14.5" width="3.4" height="8" rx="1.7"/><rect class="ear" x="27" y="14.5" width="3.4" height="8" rx="1.7"/><ellipse class="skull" cx="17" cy="18.5" rx="11" ry="12.5"/>${dots}</svg>`;
}
export const battHTML = (b) => (b == null ? '<span class="dim">Battery</span> <span class="dim">--</span>' : `<span class="bt ${b < 25 ? 'low' : ''}" style="--b:${b}%"><b></b></span><span>${b}%</span>`);

const pad = (n) => String(n).padStart(2, '0');
export const fmtClock = (t) => { t = Math.max(0, Math.floor(t)); return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`; };
export const fmtMS = (t) => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 60)}:${pad(t % 60)}`; };
export const fmtMB = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);

export const ZONE_NAMES = ['Below zones', 'Recovery', 'Endurance', 'Aerobic', 'Threshold', 'Maximum'];
export function zoneBadge(zone) {
  if (zone == null) return '<span class="zb none"><i></i><b>NO ZONE</b><span>Add a max HR</span></span>';
  return `<span class="zb" style="--zc:var(--z${zone})"><i></i><b>${zone === 0 ? 'BELOW Z1' : 'ZONE ' + zone}</b><span>${ZONE_NAMES[zone]}</span></span>`;
}

let toastTimer = 0;
export function toast(msg, ms = 4200) {
  let t = $('#toast');
  if (!t) { t = el('<div class="toast" id="toast" role="status" hidden></div>'); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** [what happened, what to do next] as one message. */
export const say = (pair) => `${pair[0]} ${pair[1]}`;

/** innerHTML only when it changed (keeps focus and avoids layout work at 4 Hz). */
export function setHTML(node, html) { if (node && node._h !== html) { node.innerHTML = html; node._h = html; } return node; }
export function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; return node; }

/** A modal built on <dialog>. Resolves with the value passed to close(). */
export function modal(html, wire) {
  const d = el(`<dialog>${html}</dialog>`);
  document.body.append(d);
  return new Promise((resolve) => {
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    wire(d, close);
    d.showModal();
  });
}
