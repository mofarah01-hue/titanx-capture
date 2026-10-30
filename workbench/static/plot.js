// Small canvas plotting for the workbench: lanes stacked on one shared time axis. Wheel zooms around
// the pointer, drag pans, double click shows everything. No library, nothing from the network.

export class View {
  constructor() { this.t0 = 0; this.t1 = 1; this.full = [0, 1]; this.subs = new Set(); this.cursor = null; }
  set(t0, t1, quiet) {
    const minW = 0.5;
    if (t1 - t0 < minW) { const c = (t0 + t1) / 2; t0 = c - minW / 2; t1 = c + minW / 2; }
    this.t0 = t0; this.t1 = t1;
    if (!quiet) for (const f of this.subs) f('range');
  }
  setFull(a, b) { this.full = [a, b]; }
  reset() { this.set(this.full[0], this.full[1]); }
  setCursor(t) { this.cursor = t; for (const f of this.subs) f('cursor'); }
  on(f) { this.subs.add(f); }
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** One lane: a canvas with a title, a y axis, and series drawn from data the app hands it. */
export class Lane {
  /**
   * o: { title, height, yFixed: [lo, hi] | null, unit, zones: () => [{lo, hi, color}] | null, marks: () => [t] }
   * series: [{ name, color, kind: 'env' | 'raw' | 'hr' | 'beats', data, offset?, scale? }]
   */
  constructor(parent, view, o) {
    this.view = view; this.o = o; this.series = [];
    this.el = document.createElement('div'); this.el.className = 'lane';
    this.el.innerHTML = `<div class="lane-head"><span class="lane-title"></span><span class="lane-legend"></span></div><canvas></canvas>`;
    parent.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.el.querySelector('.lane-title').textContent = o.title;
    this.canvas.style.height = `${o.height || 110}px`;
    this.bind();
    view.on(() => this.draw());
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  setTitle(t) { this.el.querySelector('.lane-title').textContent = t; }
  setSeries(s) {
    this.series = s;
    this.el.querySelector('.lane-legend').innerHTML = s.filter((x) => x.name).map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('');
    this.draw();
  }
  remove() { this.el.remove(); this.dead = true; }

  bind() {
    const c = this.canvas, v = this.view;
    const tAt = (x) => v.t0 + (x / c.clientWidth) * (v.t1 - v.t0);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const t = tAt(e.offsetX), k = Math.exp(e.deltaY * 0.0015);
      let a = t - (t - v.t0) * k, b = t + (v.t1 - t) * k;
      const [fa, fb] = v.full, w = b - a;
      if (w > fb - fa) { a = fa; b = fb; } else { if (a < fa) { a = fa; b = fa + w; } if (b > fb) { b = fb; a = fb - w; } }
      v.set(a, b);
    }, { passive: false });
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, t0: v.t0, t1: v.t1 }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      v.setCursor(tAt(e.offsetX));
      if (!drag) return;
      const dt = ((e.clientX - drag.x) / c.clientWidth) * (drag.t1 - drag.t0);
      let a = drag.t0 - dt, b = drag.t1 - dt;
      const [fa, fb] = v.full, w = b - a;
      if (a < fa) { a = fa; b = fa + w; } if (b > fb) { b = fb; a = fb - w; }
      v.set(a, b);
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('pointerleave', () => v.setCursor(null));
    c.addEventListener('dblclick', () => v.reset());
  }

  yRange() {
    if (this.o.yFixed) return this.o.yFixed;
    let lo = Infinity, hi = -Infinity;
    const { t0, t1 } = this.view;
    for (const s of this.series) {
      const d = s.data; if (!d || s.kind === 'beats') continue;
      const off = s.offset || 0, sc = s.scale || 1;
      if (s.kind === 'hr') { for (const p of d) if (p.t >= t0 && p.t <= t1 && p.bpm != null) { lo = Math.min(lo, p.bpm); hi = Math.max(hi, p.bpm); } continue; }
      const T = d.t, A = d.mode === 'env' ? d.min[s.ch || 0] : d.v[s.ch || 0], B = d.mode === 'env' ? d.max[s.ch || 0] : A;
      for (let i = 0; i < T.length; i++) {
        if (T[i] < t0 || T[i] > t1 || A[i] == null) continue;
        lo = Math.min(lo, A[i] * sc + off); hi = Math.max(hi, B[i] * sc + off);
      }
    }
    if (!Number.isFinite(lo)) return [0, 1];
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    if (this.o.minSpan && hi - lo < this.o.minSpan) { const c = (lo + hi) / 2; lo = c - this.o.minSpan / 2; hi = c + this.o.minSpan / 2; }
    const pad = (hi - lo) * 0.06;
    return [lo - pad, hi + pad];
  }

  draw() {
    if (this.dead) return;
    const c = this.canvas, dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const { t0, t1 } = this.view;
    const L = 46, R = W - 4, top = 4, bot = H - 16;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (R - L);
    const [ylo, yhi] = this.yRange();
    const Y = (y) => bot - ((y - ylo) / (yhi - ylo)) * (bot - top);
    // zone bands
    const zones = this.o.zones?.();
    if (zones) for (const z of zones) {
      const a = Math.max(ylo, z.lo), b = Math.min(yhi, z.hi);
      if (b <= a) continue;
      g.fillStyle = z.color; g.fillRect(L, Y(b), R - L, Y(a) - Y(b));
      if (Y(a) - Y(b) > 11) { g.fillStyle = css('--muted'); g.font = '10px system-ui'; g.fillText(z.label, R - 22, Y(b) + 10); }
    }
    // grid and axes
    g.strokeStyle = css('--grid'); g.fillStyle = css('--muted'); g.font = '10px system-ui'; g.lineWidth = 1;
    for (const y of ticks(ylo, yhi, Math.max(2, Math.floor((bot - top) / 28)))) {
      g.beginPath(); g.moveTo(L, Y(y) + 0.5); g.lineTo(R, Y(y) + 0.5); g.stroke();
      g.fillText(fmt(y), 2, Y(y) + 3);
    }
    for (const t of ticks(t0, t1, Math.max(2, Math.floor(W / 90)))) {
      g.beginPath(); g.moveTo(X(t) + 0.5, top); g.lineTo(X(t) + 0.5, bot); g.stroke();
      g.fillText(tfmt(t), X(t) + 2, H - 4);
    }
    // marks (annotations)
    const marks = this.o.marks?.() || [];
    g.strokeStyle = css('--mark'); g.setLineDash([3, 3]);
    for (const m of marks) if (m.t >= t0 && m.t <= t1) { g.beginPath(); g.moveTo(X(m.t) + 0.5, top); g.lineTo(X(m.t) + 0.5, bot); g.stroke(); }
    g.setLineDash([]);
    g.save(); g.beginPath(); g.rect(L, top, R - L, bot - top); g.clip();
    for (const s of this.series) {
      const d = s.data; if (!d) continue;
      g.strokeStyle = s.color; g.fillStyle = s.color; g.lineWidth = s.width || 1.2;
      const off = s.offset || 0, sc = s.scale || 1;
      if (s.kind === 'hr') {
        g.beginPath(); let pen = false, lastT = null;
        for (const p of d) {
          if (p.t < t0 - 5 || p.t > t1 + 5) continue;
          if (p.bpm == null || (lastT != null && p.t - lastT > 3.5)) { pen = false; }
          if (p.bpm != null) { const x = X(p.t), y = Y(p.bpm); if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true; lastT = p.t; }
        }
        g.stroke();
        if ((t1 - t0) < 400) for (const p of d) if (p.bpm != null && p.t >= t0 && p.t <= t1) { g.globalAlpha = 0.25 + 0.75 * Math.min(1, p.conf ?? 1); g.fillRect(X(p.t) - 1.5, Y(p.bpm) - 1.5, 3, 3); }
        g.globalAlpha = 1;
      } else if (s.kind === 'beats') {
        for (const [t, ok] of d) if (t >= t0 && t <= t1) { g.fillStyle = ok ? s.color : css('--bad'); g.fillRect(X(t) - 1, top, 2, 6); }
      } else if (d.mode === 'env') {
        const T = d.t, A = d.min[s.ch || 0], B = d.max[s.ch || 0];
        g.beginPath();
        for (let i = 0; i < T.length; i++) { if (A[i] == null) continue; const x = X(T[i]); g.moveTo(x + 0.5, Y(B[i] * sc + off)); g.lineTo(x + 0.5, Y(A[i] * sc + off) + 0.5); }
        g.stroke();
      } else {
        const T = d.t, V = d.v[s.ch || 0];
        g.beginPath(); let pen = false;
        for (let i = 0; i < T.length; i++) {
          if (V[i] == null || (i && T[i] - T[i - 1] > 0.6)) { pen = false; if (V[i] == null) continue; }
          const x = X(T[i]), y = Y(V[i] * sc + off);
          if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true;
        }
        g.stroke();
      }
    }
    g.restore();
    if (this.view.cursor != null && this.view.cursor >= t0 && this.view.cursor <= t1) {
      g.strokeStyle = css('--cursor'); g.beginPath(); g.moveTo(X(this.view.cursor) + 0.5, top); g.lineTo(X(this.view.cursor) + 0.5, bot); g.stroke();
    }
    g.strokeStyle = css('--grid'); g.strokeRect(L + 0.5, top + 0.5, R - L - 1, bot - top - 1);
  }
}

export function ticks(a, b, n) {
  const span = b - a; if (!(span > 0)) return [];
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  const out = []; for (let t = Math.ceil(a / step) * step; t <= b; t += step) out.push(t);
  return out;
}
const fmt = (y) => { const a = Math.abs(y); return a >= 1e5 ? `${(y / 1e3).toFixed(0)}k` : a >= 100 ? y.toFixed(0) : a >= 1 ? y.toFixed(1) : y.toFixed(2); };
export const tfmt = (t) => { if (Math.abs(t) < 120) return `${+t.toFixed(1)}s`; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(s % 1 ? 1 : 0)}`; };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
