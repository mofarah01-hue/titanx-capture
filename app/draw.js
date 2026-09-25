// Canvas drawing: trace lanes, sparklines, the session strip and the timeline. Colours come from
// the CSS tokens so the page and the canvases can never disagree. Lines break at every gap in
// the data; nothing is drawn across missing samples.
import { fmtMS, eventColor } from './ui.js';

export let C = {};
const TOK = ['bg', 'bg2', 'panel', 'card', 'line', 'line2', 'edge', 'text', 'dim', 'faint', 'accent', 'ppg', 'ppg1', 'ppg2', 'amb', 'acc', 'acc2', 'acc3', 'gyro', 'gyro2', 'gyro3', 'mag', 'mag2', 'mag3', 'ours', 'polar', 'ppi', 'z0', 'z1', 'z2', 'z3', 'z4', 'z5', 'ok', 'warn', 'bad', 'ev-still', 'ev-light', 'ev-heavy', 'ev-adj', 'ev-wrong', 'ev-mark', 'font'];
export function readTokens() { const cs = getComputedStyle(document.documentElement); C = {}; for (const k of TOK) C[k] = cs.getPropertyValue('--' + k).trim(); }

export function fit(c) {
  const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

const patterns = new Map();
export function hatch(ctx, col) {
  let p = patterns.get(col);
  if (!p) { p = document.createElement('canvas'); p.width = p.height = 6; const g = p.getContext('2d'); g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(-1, 7); g.lineTo(7, -1); g.stroke(); patterns.set(col, p); }
  return ctx.createPattern(p, 'repeat');
}

/** First index with t >= t0 (buffers are sorted by time). */
export function lowerBound(t, t0) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < t0) lo = m + 1; else hi = m; } return lo; }
const tick = (v) => (Math.abs(v) < 10 && v % 1 ? v.toFixed(1) : String(v));
/** Whole session axis: end just past now, rounded to a minute; tick spacing that suits the length. */
const sessionEnd = (t) => Math.max(60, Math.ceil((t + 15) / 60) * 60);
const stepFor = (span) => (span <= 120 ? 15 : span <= 600 ? 60 : span <= 3600 ? 300 : 900);

/**
 * One lane. spec: { win (s), range: [lo, hi] or auto: true, ticks, series: [{ buf, ch, color, dash, lw, map, gapS }] },
 * pins: [{ t, label, text }], empty: text when nothing to draw.
 */
export function drawLane(c, spec, t, pins = []) {
  const { ctx, w, h } = fit(c); ctx.clearRect(0, 0, w, h);
  const pl = 38, pr = 6, pt = 14, pb = 16, pw = w - pl - pr, ph = h - pt - pb;
  const W = spec.win || 10, t0 = t - W;
  let [lo, hi] = spec.range || [0, 1];
  if (spec.auto) {
    let mn = Infinity, mx = -Infinity;
    for (const S of spec.series) {
      const b = S.buf, i0 = lowerBound(b.t, t0), ch = b.ch;
      for (let i = i0; i < b.t.length; i++) { const v = (S.map || ((x) => x))(b.v[i * ch + (S.ch || 0)]); if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    if (Number.isFinite(mn)) {
      const span = Math.max(mx - mn, spec.minSpan || 1e-9), target = [mn - span * 0.12, mx + span * 0.12];
      const prev = spec._r || target;
      spec._r = [prev[0] + (target[0] - prev[0]) * 0.12, prev[1] + (target[1] - prev[1]) * 0.12];
      [lo, hi] = spec._r;
    }
  }
  const X = (x) => pl + (x - t0) / W * pw, Y = (v) => pt + (1 - (v - lo) / (hi - lo || 1)) * ph;
  ctx.font = `600 10px ${C.font}`; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const ticks = spec.auto ? [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15] : spec.ticks;
  for (const v of ticks) {
    const y = Math.round(Y(v)) + 0.5; ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(w - pr, y); ctx.stroke();
    if (!spec.auto) { ctx.fillStyle = C.dim; ctx.fillText(tick(v), pl - 6, y); }
  }
  if (spec.auto && spec.unitLabel) { ctx.fillStyle = C.dim; ctx.fillText(spec.unitLabel, pl - 6, Y((lo + hi) / 2)); }
  const step = W <= 12 ? 2 : W <= 60 ? 10 : 60;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let m = Math.ceil(t0 / step) * step; m <= t; m += step) {
    if (m < 0) continue;
    const x = Math.round(X(m)) + 0.5; ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, pt + ph); ctx.stroke();
    ctx.fillStyle = C.dim; ctx.fillText(fmtMS(m), x, pt + ph + 3);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(pl, pt - 2, pw, ph + 4); ctx.clip();
  let any = false;
  for (const S of spec.series) {
    const b = S.buf, ch = b.ch, i0 = lowerBound(b.t, t0), map = S.map || ((x) => x), gap = S.gapS || 0.35;
    ctx.beginPath(); let pen = false, lastT = -Infinity;
    for (let i = i0; i < b.t.length; i++) {
      const tt = b.t[i], v = map(b.v[i * ch + (S.ch || 0)]);
      if (tt - lastT > gap) pen = false;
      lastT = tt;
      if (!Number.isFinite(v)) { pen = false; continue; }
      any = true;
      const x = X(tt), y = Y(Math.max(lo, Math.min(hi, v)));
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = C[S.color]; ctx.lineWidth = S.lw || 1.5; ctx.setLineDash(S.dash ? [5, 4] : []); ctx.stroke(); ctx.setLineDash([]);
  }
  if (!any) { ctx.fillStyle = C.dim; ctx.font = `600 12px ${C.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(spec.empty || 'No data yet', pl + 10, pt + ph / 2); }
  ctx.restore();
  ctx.font = `700 10px ${C.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const mk of pins) {
    if (mk.t < t0 || mk.t > t) continue;
    const x = Math.round(X(mk.t)) + 0.5, col = C[eventColor(mk.label)];
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, pt + ph); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, pt, 3.5, 0, 7); ctx.fill();
    ctx.fillText(mk.text || mk.label, x + 7, pt - 1);
  }
}

/** 60 s of heart rate (Polar dashed), or 3 s of raw PPG for a sensor in Max rate mode. */
export function drawSpark(c, hrBuf, ppgBuf, maxMode, t) {
  const { ctx, w, h } = fit(c); ctx.clearRect(0, 0, w, h);
  ctx.font = `600 10px ${C.font}`; ctx.textBaseline = 'top'; ctx.fillStyle = C.dim;
  if (maxMode) {
    const i0 = lowerBound(ppgBuf.t, t - 3), n = ppgBuf.t.length - i0;
    ctx.fillText('RAW PPG · LAST 3 S', 0, 0);
    if (n < 2) return;
    let mn = Infinity, mx = -Infinity; for (let i = i0; i < ppgBuf.t.length; i++) { const v = ppgBuf.v[i * ppgBuf.ch]; mn = Math.min(mn, v); mx = Math.max(mx, v); }
    ctx.beginPath();
    for (let i = i0; i < ppgBuf.t.length; i++) { const x = (ppgBuf.t[i] - (t - 3)) / 3 * w, y = 14 + (1 - (ppgBuf.v[i * ppgBuf.ch] - mn) / (mx - mn || 1)) * (h - 16); i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = C.ppg; ctx.lineWidth = 1.3; ctx.stroke(); return;
  }
  ctx.fillText('POLAR HR · LAST 60 S', 0, 0);
  const i0 = lowerBound(hrBuf.t, t - 60);
  if (hrBuf.t.length - i0 < 1) { ctx.fillText('No heart rate in the last 60 s', 0, 20); return; }
  let mn = Infinity, mx = -Infinity; for (let i = i0; i < hrBuf.t.length; i++) { mn = Math.min(mn, hrBuf.v[i]); mx = Math.max(mx, hrBuf.v[i]); }
  mn -= 6; mx += 6;
  const X = (x) => (x - (t - 60)) / 60 * w, Y = (v) => h - 2 - (v - mn) / (mx - mn) * (h - 18);
  ctx.beginPath(); let last = -Infinity;
  for (let i = i0; i < hrBuf.t.length; i++) { const tt = hrBuf.t[i]; if (tt - last > 12) ctx.moveTo(X(tt), Y(hrBuf.v[i])); else ctx.lineTo(X(tt), Y(hrBuf.v[i])); last = tt; }
  ctx.setLineDash([4, 3]); ctx.strokeStyle = C.polar; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
}

/**
 * Whole session so far: one row per sensor coloured by heart rate zone, hatched where there is
 * no data, event pins across the rows they belong to.
 * rows: [{ label, hrBuf, max, maxMode, athleteId }]
 */
export function drawStrip(c, rows, marks, t) {
  const L = 150, R = 14, top = 26, rowH = 12, gap = 4, T = sessionEnd(t);
  c.style.height = `${top + rows.length * (rowH + gap) + 6}px`; // every athlete gets a row
  const { ctx, w, h } = fit(c); ctx.clearRect(0, 0, w, h);
  const X = (x) => L + x / T * (w - L - R), bottom = top + rows.length * (rowH + gap) - gap;
  ctx.font = `600 11px ${C.font}`; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  const step = stepFor(T);
  for (let m = 0; m <= T; m += step) { const x = Math.round(X(m)) + 0.5; ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, bottom); ctx.stroke(); ctx.fillStyle = C.dim; ctx.textAlign = m === 0 ? 'left' : m === T ? 'right' : 'center'; ctx.fillText(fmtMS(m), x, 9); }
  rows.forEach((r, i) => {
    const y = top + i * (rowH + gap), x0 = X(0), x1 = X(Math.max(0, t));
    ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.fillText(r.label, 0, y + rowH / 2);
    ctx.fillStyle = C.bg2; ctx.fillRect(x0, y, x1 - x0, rowH); ctx.fillStyle = hatch(ctx, C.faint); ctx.fillRect(x0, y, x1 - x0, rowH);
    if (r.maxMode) { ctx.fillStyle = C.dim; ctx.fillText('Max rate mode, raw streams only', x0 + 6, y + rowH / 2 + 0.5); return; }
    const b = r.hrBuf; let j = 0;
    for (let px = Math.floor(x0); px < x1; px++) {
      const tt = (px + 0.5 - L) / (w - L - R) * T;
      while (j + 1 < b.t.length && b.t[j + 1] <= tt) j++;
      if (!b.t.length || b.t[j] > tt || tt - b.t[j] > 8) continue;
      const z = r.zoneOf(b.v[j]);
      ctx.fillStyle = z == null ? C.z0 : C['z' + z]; ctx.fillRect(px, y, 1.2, rowH);
    }
  });
  for (const mk of marks) {
    const x = Math.round(X(mk.t)) + 0.5, col = C[eventColor(mk.label)]; ctx.strokeStyle = col; ctx.fillStyle = col;
    rows.forEach((r, i) => { if (mk.target !== 'all' && mk.target !== r.athleteId) return; const y = top + i * (rowH + gap); ctx.beginPath(); ctx.moveTo(x, y - 1); ctx.lineTo(x, y + rowH + 1); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(x - 4.5, top - 11); ctx.lineTo(x + 4.5, top - 11); ctx.lineTo(x, top - 4); ctx.closePath(); ctx.fill();
  }
  const xn = Math.round(X(t)) + 0.5; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(xn, top - 4); ctx.lineTo(xn, bottom + 2); ctx.stroke();
}

/**
 * Session timeline: a lane per sensor on one time axis. Polar HR dashed, zone ribbon, movement
 * strip from ACC, hatched gaps with a label, event pins with text.
 * rows: [{ name, sub, mode, hrBuf, accBuf, zoneOf, athleteId, gaps: [{from, to, text}] }]
 */
export function drawTimeline(c, rows, marks, t, zoom) {
  const rowH = 76, laneH = 54, act = 8, top = 44, L = 170, R = 16;
  c.style.height = `${top + Math.max(1, rows.length) * rowH + 8}px`;
  const { ctx, w, h } = fit(c); ctx.clearRect(0, 0, w, h);
  const t0 = zoom === 'all' ? 0 : Math.max(0, t - 300), t1 = zoom === 'all' ? sessionEnd(t) : Math.max(t0 + 60, t + 15);
  const X = (x) => L + (x - t0) / (t1 - t0) * (w - L - R), bottom = top + rows.length * rowH - (rowH - laneH - act), F = C.font;
  const step = zoom === 'all' ? stepFor(t1) : 30;
  ctx.font = `600 11px ${F}`; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  for (let m = Math.ceil(t0 / step) * step; m <= t1; m += step) { const x = Math.round(X(m)) + 0.5; ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, bottom); ctx.stroke(); ctx.fillStyle = C.dim; ctx.textAlign = 'center'; ctx.fillText(fmtMS(m), x, 10); }
  if (!rows.length) { ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.fillText('No sensors in this session yet.', L, top + 20); }
  const dt = Math.max(0.5, (t1 - t0) / (w - L - R));
  rows.forEach((r, i) => {
    const y = top + i * rowH, lo = 50, hi = 210, Y = (v) => y + laneH - 5 - (v - lo) / (hi - lo) * (laneH - 10);
    ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.font = `700 14px ${F}`; ctx.fillText(r.name, 12, y + 12);
    ctx.fillStyle = C.dim; ctx.font = `600 12px ${F}`; ctx.fillText(r.sub, 12, y + 29);
    ctx.fillStyle = r.mode === 'max' ? C.accent : C.faint; ctx.fillText(r.mode === 'max' ? 'Max rate mode' : 'Polar mode', 12, y + 45);
    ctx.fillStyle = C.bg2; ctx.fillRect(L, y, w - L - R, laneH);
    ctx.strokeStyle = C.line; for (const g of [100, 150, 200]) { const yy = Math.round(Y(g)) + 0.5; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke(); }
    // movement strip: per second mean of ||a| - 1 g|, brighter means more movement
    const mb = r.moveBuf;
    if (mb?.t.length) {
      let j = lowerBound(mb.t, t0);
      for (let tt = t0; tt < Math.min(t, t1) && j < mb.t.length; tt += dt) {
        let s = 0, n = 0;
        while (j < mb.t.length && mb.t[j] < tt + dt) { s += mb.v[j]; n++; j++; }
        if (!n) continue;
        ctx.globalAlpha = 0.12 + 0.88 * Math.min(1, (s / n) * 2.5); ctx.fillStyle = C.acc; ctx.fillRect(X(tt), y + laneH + 1, Math.max(1, X(tt + dt) - X(tt) + 0.4), act - 2);
      }
      ctx.globalAlpha = 1;
    }
    if (r.mode === 'max') { ctx.fillStyle = hatch(ctx, C.faint); ctx.fillRect(X(t0), y, X(Math.min(t, t1)) - X(t0), laneH); ctx.fillStyle = C.dim; ctx.font = `600 12px ${F}`; ctx.fillText('Polar HR is off in Max rate mode. Our HR will draw here.', X(t0) + 8, y + laneH / 2); }
    else {
      const b = r.hrBuf; const i0 = lowerBound(b.t, t0);
      ctx.beginPath(); let last = -Infinity;
      for (let k = i0; k < b.t.length && b.t[k] <= t1; k++) {
        const tt = b.t[k], v = b.v[k], z = r.zoneOf(v);
        ctx.fillStyle = z == null ? C.z0 : C['z' + z];
        const nx = k + 1 < b.t.length && b.t[k + 1] - tt <= 8 ? b.t[k + 1] : tt + 1;
        ctx.fillRect(X(tt), y + laneH - 4, Math.max(1, X(nx) - X(tt) + 0.4), 4);
        if (tt - last > 12) ctx.moveTo(X(tt), Y(v)); else ctx.lineTo(X(tt), Y(v));
        last = tt;
      }
      ctx.setLineDash([5, 4]); ctx.strokeStyle = C.polar; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    }
    for (const g of r.gaps) {
      const to = g.to ?? t;
      if (to < t0 || g.from > t1) continue;
      const ga = Math.max(L, X(g.from)), gb = Math.min(w - R, X(to));
      ctx.fillStyle = C.bg2; ctx.fillRect(ga, y, Math.max(2, gb - ga), laneH + act);
      ctx.fillStyle = hatch(ctx, C.warn); ctx.fillRect(ga, y, Math.max(2, gb - ga), laneH + act);
      // A label only where it fits inside the gap; narrow gaps show as hatching alone.
      ctx.font = `700 11px ${F}`; const tw = ctx.measureText(g.text).width + 10;
      if (gb - ga > tw + 8) { ctx.fillStyle = C.bg; ctx.fillRect(ga + 4, y + 4, tw, 17); ctx.fillStyle = C.warn; ctx.textAlign = 'left'; ctx.fillText(g.text, ga + 9, y + 12.5); }
    }
  });
  let lastRight = -1; ctx.font = `700 11px ${F}`;
  for (const mk of marks) {
    if (mk.t < t0 || mk.t > t1) continue;
    const x = Math.round(X(mk.t)) + 0.5, col = C[eventColor(mk.label)];
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.globalAlpha = 0.85;
    rows.forEach((r, i) => { if (mk.target !== 'all' && mk.target !== r.athleteId) return; const y = top + i * rowH; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + laneH + act); ctx.stroke(); });
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(x - 5, 24); ctx.lineTo(x + 5, 24); ctx.lineTo(x, 32); ctx.closePath(); ctx.fill();
    const txt = (mk.text || mk.label) + (mk.who ? ` · ${mk.who}` : ''), tw = ctx.measureText(txt).width;
    if (x + 7 > lastRight && x + 7 + tw < w) { ctx.textAlign = 'left'; ctx.fillText(txt, x + 8, 29); lastRight = x + 8 + tw + 10; }
  }
  const xn = Math.round(X(t)) + 0.5; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(xn, 18); ctx.lineTo(xn, bottom); ctx.stroke(); ctx.lineWidth = 1;
}
