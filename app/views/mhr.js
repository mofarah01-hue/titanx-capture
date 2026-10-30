// Motion HR (Engineering > Motion HR): every stage of the heart rate chain with its switch and settings,
// per axis weights for the motion references, and named profiles. A change applies at once to every
// connected sensor (their engines restart, so the HR needs about 8 s to come back) and is kept on this
// device. The spectrum at the bottom shows what the HR pick sees right now.
import { S, slotIds, athleteName, resetMhr } from '../state.js';
import { STAGES, defaultConfig, mergeConfig } from '../../core/algo/motionhr.js';
import { kvGet, kvSet } from '../../core/storage/kv.js';
import { esc, $, $$, toast, modal } from '../ui.js';
import { C, fit as fitC } from '../draw.js';

let root = null, sel = null, profiles = {};
const AXES = { acc: 'Accelerometer', gyro: 'Gyroscope', mag: 'Magnetometer' };

// The settings each stage shows: [key, label, min, max, step, unit]
const PARAMS = {
  bandpass: [['lo', 'Low corner', 0.2, 1.5, 0.05, 'Hz'], ['hi', 'High corner', 2.5, 6, 0.1, 'Hz']],
  nlms: [['mu', 'Step size µ', 0.005, 1, 0.005, ''], ['taps', 'Taps (25 Hz)', 2, 32, 1, '']],
  notch: [['width', 'Half width', 0.03, 0.3, 0.01, 'Hz'], ['minG', 'Only above', 0.02, 1, 0.01, 'g']],
  beats: [['tol', 'Rate tolerance', 0.1, 0.6, 0.05, '× HR'], ['minProm', 'Minimum size', 0.2, 1.2, 0.05, '× pulse']],
  estimate: [['spectral', 'Spectral weight', 0, 1, 0.05, ''], ['peaks', 'Beats weight', 0, 1, 0.05, '']],
  tracker: [['maxStep', 'Max change', 2, 30, 1, 'bpm/s'], ['hold', 'Hold', 0, 15, 1, 's']],
  gate: [['min', 'Minimum confidence', 0, 1, 0.05, '']],
  impact: [['g', 'Impact above', 2, 16, 0.5, 'g'], ['freeze', 'Freeze for', 0, 3, 0.1, 's']],
};

export async function loadMhr() {
  const c = await kvGet('mhr').catch(() => null);
  profiles = (await kvGet('mhrProfiles').catch(() => null)) || {};
  return mergeConfig(c);
}

export function mountMhr(container) {
  root = container;
  const ids = slotIds().filter((id) => S.links.has(id));
  if (!sel || !ids.includes(sel)) sel = ids[0] || null;
  render();
}

function render() {
  const c = S.mhr, ids = slotIds().filter((id) => S.links.has(id));
  root.innerHTML = `<div class="page mhr">
    <div class="mhr-h"><h2>Motion HR</h2>
      <label class="field inline">Profile<select data-k="prof"><option value="">(current)</option>${Object.keys(profiles).map((n) => `<option>${esc(n)}</option>`).join('')}</select></label>
      <button class="btn" data-a="save">Save as…</button><button class="btn quiet" data-a="del">Delete profile</button><button class="btn quiet" data-a="reset">Factory settings</button>
      <span class="dim">Applies to every connected sensor at once and to Past runs when you re-run them.</span></div>
    <div class="mhr-grid">
      <div class="box"><h3>PIPELINE · TOP TO BOTTOM</h3><ol class="stages">${STAGES.map(([k, name, help], i) => `<li class="${c[k].on ? '' : 'off'}">
        <label class="sw"><input type="checkbox" data-on="${k}" ${c[k].on ? 'checked' : ''} ${k === 'resample' ? 'disabled' : ''}><span>${i + 1}. ${esc(name)}</span></label>
        <div class="dim">${esc(help)}</div>
        ${(PARAMS[k] || []).map(([p, l, mn, mx, st, u]) => `<label class="field inline">${l}<input type="number" data-p="${k}.${p}" min="${mn}" max="${mx}" step="${st}" value="${c[k][p]}" style="width:80px">${u ? ` ${u}` : ''}</label>`).join('')}
        ${k === 'fusion' ? `<label class="inline"><input type="checkbox" data-p="fusion.auto" ${c.fusion.auto ? 'checked' : ''}> Weights from pulse to noise ratio</label>
          ${[0, 1, 2].map((i2) => `<label class="field inline">Ch ${i2}<input type="number" data-w="${i2}" min="0" max="1" step="0.05" value="${c.fusion.weights[i2] ?? 0}" style="width:70px" ${c.fusion.auto ? 'disabled' : ''}></label>`).join('')}` : ''}
      </li>`).join('')}</ol></div>
      <div>
        <div class="box"><h3>MOTION REFERENCES · WEIGHT PER AXIS (0 = LEFT OUT)</h3>
          <table class="health axes"><thead><tr><th></th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>${Object.entries(AXES).map(([a, n]) => `<tr><th>${n}</th>${[0, 1, 2].map((k) => `<td><input type="range" min="0" max="2" step="0.1" data-ax="${a}.${k}" value="${c.nlms.w[a][k]}"><output>${c.nlms.w[a][k].toFixed(1)}</output></td>`).join('')}</tr>`).join('')}</tbody></table>
          <p class="dim">Each axis is scaled to the same size first, so a weight of 1 means equal say. The magnetometer follows head turns (slow); punches and hits show in ACC and GYRO, so it starts at 0. Polar mode has no gyro or magnetometer: switch the sensor to Max mode.</p></div>
        <div class="box"><h3>SPECTRUM NOW <select data-k="dev">${ids.map((id) => `<option value="${id}" ${id === sel ? 'selected' : ''}>${esc(athleteName(id))} · ${id}</option>`).join('') || '<option>None connected</option>'}</select></h3>
          <canvas class="lane-c" data-k="spec" style="--lh:200px"></canvas>
          <p class="dim" data-k="specl">Clean PPG (red), movement from ACC (grey, scaled), HR pick and movement rhythm marked. 8 s window, updated every second.</p></div>
      </div>
    </div></div>`;
  wire();
}

function apply(c) {
  resetMhr(c);
  kvSet('mhr', c).catch(() => toast('Settings applied but not saved on this device.'));
}

function wire() {
  root.addEventListener('change', (ev) => {
    const t = ev.target, c = structuredClone(S.mhr);
    if (t.dataset.on) { c[t.dataset.on].on = t.checked; t.closest('li').classList.toggle('off', !t.checked); }
    else if (t.dataset.p) {
      const [k, p] = t.dataset.p.split('.');
      if (t.type === 'checkbox') { c[k][p] = t.checked; $$('[data-w]', root).forEach((x) => { x.disabled = t.checked; }); }
      else { const v = Number(t.value); if (!Number.isFinite(v)) return; c[k][p] = p === 'taps' ? Math.round(v) : v; }
      if (c.bandpass.lo >= c.bandpass.hi) { toast('The low corner must be below the high corner.'); t.value = S.mhr[k][p]; return; }
    } else if (t.dataset.w) c.fusion.weights[Number(t.dataset.w)] = Number(t.value);
    else if (t.dataset.ax) { const [a, k] = t.dataset.ax.split('.'); c.nlms.w[a][Number(k)] = Number(t.value); }
    else if (t.dataset.k === 'prof') { if (t.value && profiles[t.value]) { apply(mergeConfig(profiles[t.value])); render(); toast(`Profile ${t.value} applied.`); } return; }
    else if (t.dataset.k === 'dev') { sel = t.value; return; }
    else return;
    apply(c);
  });
  root.addEventListener('input', (ev) => { const t = ev.target; if (t.dataset.ax) t.nextElementSibling.value = Number(t.value).toFixed(1); });
  root.addEventListener('click', async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (a === 'save') {
      // the app's own dialog: prompt() and confirm() may do nothing inside the iPad app's web view
      const n = ((await modal(`<h2>Save profile</h2><label class="field">Name<input data-n maxlength="40" placeholder="Pad work, Sparring, Running…"></label>
        <div class="foot"><button class="btn primary" data-y>Save</button><button class="btn" data-x>Cancel</button></div>`, (d, close) => {
        d.querySelector('[data-y]').addEventListener('click', () => close(d.querySelector('[data-n]').value));
        d.querySelector('[data-x]').addEventListener('click', () => close(null));
      })) || '').trim();
      if (!n) return;
      profiles[n] = structuredClone(S.mhr); await kvSet('mhrProfiles', profiles).catch(() => toast('Profile not saved.'));
      render(); $('[data-k="prof"]', root).value = n; toast(`Saved as ${n}.`);
    }
    if (a === 'del') {
      const n = $('[data-k="prof"]', root).value; if (!n) { toast('Pick a profile first.'); return; }
      const yes = await modal(`<h2>Delete the profile "${esc(n)}"?</h2><p>The settings in use now stay as they are.</p>
        <div class="foot"><button class="btn primary" data-y>Delete</button><button class="btn" data-x>Keep</button></div>`, (d, close) => {
        d.querySelector('[data-y]').addEventListener('click', () => close(true));
        d.querySelector('[data-x]').addEventListener('click', () => close(false));
      });
      if (!yes) return;
      delete profiles[n]; await kvSet('mhrProfiles', profiles).catch(() => {}); render();
    }
    if (a === 'reset') { apply(defaultConfig()); render(); toast('Factory settings applied.'); }
  });
}

export function drawMhr() {
  if (!root) return;
  const cv = $('[data-k="spec"]', root), e = sel && S.links.get(sel), sp = e?.mhr?.spectrum;
  if (!cv?.offsetParent) return;
  const { ctx, w, h } = fitC(cv); ctx.clearRect(0, 0, w, h);
  ctx.font = `600 11px ${C.font}`; ctx.fillStyle = C.dim;
  if (!sp) { ctx.fillText('Waiting for 8 s of data', 40, h / 2); return; }
  const pl = 34, pb = 18, pw = w - pl - 8, ph = h - pb - 8, f = sp.f, n = f.length;
  const X = (fr) => pl + ((fr - f[0]) / (f[n - 1] - f[0])) * pw;
  ctx.textAlign = 'center';
  for (let b = 40; b <= 210; b += 20) { const x = X(b / 60); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 4 + ph); ctx.stroke(); ctx.fillText(String(b), x, h - 6); }
  const line = (p, col, lw) => { let m = 0; for (const v of p) m = Math.max(m, v); if (!m) return; ctx.beginPath(); for (let j = 0; j < n; j++) { const x = X(f[j]), y = 4 + ph * (1 - p[j] / m); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); };
  if (sp.acc) line(sp.acc, C.faint, 1.2);
  line(sp.p, C.z5, 1.8);
  const r = e.mhrLast, mark = (bpm, col, label) => { if (!bpm) return; const x = X(bpm / 60); ctx.strokeStyle = col; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 4 + ph); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.fillText(label, x + 4, 14); };
  mark(r?.cadence, C.dim, `rhythm ${Math.round(r?.cadence || 0)}`);
  mark(r?.tracked, C.z5, `HR ${Math.round(r?.tracked || 0)}`);
  ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.fillText('bpm', 4, h - 6);
}

export const refreshMhr = () => {};
export const unmountMhr = () => { root = null; };
