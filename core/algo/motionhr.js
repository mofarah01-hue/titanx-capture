// Motion robust heart rate. One engine for live (state.js feeds it sample by sample) and for past runs
// (runOffline replays the recorded CSVs through the same code), so what the engineering page shows live
// is what post-processing starts from. Every stage can be switched off and tuned from the Motion HR
// tab; the settings object is plain JSON so profiles can be saved.
//
// Chain, on a common 25 Hz grid (HR lives below 4 Hz, so 25 Hz loses nothing and costs little):
//   1 resample      every stream (PPG channels, ACC, GYRO, MAG) linearly onto the grid
//   2 ambient       subtract the ambient channel (Polar channel 3) from each green
//   3 band-pass     0.5 to 4 Hz on PPG and on every motion axis
//   4 fusion        each PPG channel scaled to unit size, then weighted by its pulse to noise ratio
//                   (plain averaging does not cancel motion: motion is common to all channels)
//   5 NLMS          adaptive filter that predicts the motion part of the PPG from the motion axes and
//                   subtracts it. Per axis weights scale each reference; 0 leaves the axis out
//   6 cadence notch removes the main movement rhythm (from |a|) unless it sits on the heart rate
//   7 HR estimate   spectral peak (8 s window, every second) blended with beat to beat intervals
//   8 tracker       HR may change at most maxStep bpm per second; held for `hold` s, then no answer
//   9 quality gate  confidence 0..1 from peak sharpness, agreement, motion; below `min` nothing shown
//  10 impact        |a| above `g` freezes adaptation and drops beats for `freeze` s
// Post-processing adds a Viterbi pass over the whole run's spectra (forward and backward), which can
// use the future as well as the past to pick the heart line through motion.

import { BandPass, Biquad } from './filters.js';
import { estimateBpm, MIN_BEAT_S, WINDOW_S } from './hr.js';

export const FS = 25;
const F_LO = 0.6, F_HI = 3.6;     // 36 to 216 bpm searched
const NFFT = 1024;                 // zero padded: 25 / 1024 Hz = 1.46 bpm per bin

export const STAGES = [
  ['resample', 'Resample', 'Every stream onto one 25 Hz grid'],
  ['ambient', 'Ambient subtract', 'Green minus the ambient channel (Polar only)'],
  ['bandpass', 'Band-pass', 'PPG and motion axes, low to high corner'],
  ['fusion', 'Channel fusion', 'Unit size channels, weighted by pulse to noise ratio (or your weights)'],
  ['nlms', 'Motion removal (NLMS)', 'Predicts the motion part of the PPG from ACC, GYRO, MAG and subtracts it'],
  ['notch', 'Cadence notch', 'Removes the main movement rhythm unless it sits on the heart rate'],
  ['beats', 'Beat screening', 'Peak finder on the clean signal; drops beats in an impact, off the tracked rate, or too small. Off: every peak counts'],
  ['estimate', 'HR estimate', 'Spectral peak blended with beat to beat intervals'],
  ['tracker', 'Tracker', 'Limits how fast HR may change, holds through short dropouts'],
  ['gate', 'Quality gate', 'Shows no number below the minimum confidence'],
  ['impact', 'Impact handling', 'Freezes adaptation and drops beats after a hit'],
];

export function defaultConfig() {
  return {
    resample: { on: true },
    ambient: { on: true },
    bandpass: { on: true, lo: 0.5, hi: 4 },
    fusion: { on: true, auto: true, weights: [1, 1, 1] },
    nlms: { on: true, mu: 0.1, taps: 8, w: { acc: [1, 1, 1], gyro: [1, 1, 1], mag: [0, 0, 0] } },
    notch: { on: true, width: 0.1, minG: 0.08 },
    beats: { on: true, tol: 0.3, minProm: 0.6 },
    estimate: { on: true, spectral: 0.7, peaks: 0.3 },
    tracker: { on: true, maxStep: 10, hold: 5 },
    gate: { on: true, min: 0.45 },
    impact: { on: true, g: 6, freeze: 0.5 },
  };
}

/** A saved profile merged over the defaults, so an old profile still gets new fields. */
export function mergeConfig(c) {
  const d = defaultConfig();
  if (!c || typeof c !== 'object') return d;
  for (const k of Object.keys(d)) if (c[k] && typeof c[k] === 'object') d[k] = { ...d[k], ...c[k], ...(k === 'nlms' ? { w: { ...d.nlms.w, ...(c.nlms.w || {}) } } : {}) };
  return d;
}

// ---------- small pieces ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

/** Fixed length ring of floats with the newest last. */
class Ring {
  constructor(n) { this.a = new Float32Array(n); this.n = n; this.i = 0; this.full = false; }
  push(x) { this.a[this.i] = x; this.i = (this.i + 1) % this.n; if (!this.i) this.full = true; }
  /** Oldest first copy into out (length n). */
  copy(out) { const k = this.n - this.i; out.set(this.a.subarray(this.i), 0); out.set(this.a.subarray(0, this.i), k); return out; }
  get count() { return this.full ? this.n : this.i; }
}

/** Power spectrum of an evenly sampled window between F_LO and F_HI, Hann window, zero padded to NFFT. */
class Spectrum {
  constructor(n, fs = FS) {
    this.n = n; this.k0 = Math.ceil(F_LO * NFFT / fs); this.k1 = Math.floor(F_HI * NFFT / fs);
    this.f = Float32Array.from({ length: this.k1 - this.k0 + 1 }, (_, j) => (this.k0 + j) * fs / NFFT);
    const B = this.f.length;
    this.cos = new Float32Array(B * n); this.sin = new Float32Array(B * n);
    for (let j = 0; j < B; j++) for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)), a = 2 * Math.PI * (this.k0 + j) * i / NFFT;
      this.cos[j * n + i] = w * Math.cos(a); this.sin[j * n + i] = w * Math.sin(a);
    }
  }
  of(x) {
    const n = this.n, B = this.f.length, p = new Float32Array(B);
    let m = 0; for (let i = 0; i < n; i++) m += x[i]; m /= n;
    for (let j = 0; j < B; j++) {
      let re = 0, im = 0; const o = j * n;
      for (let i = 0; i < n; i++) { const v = x[i] - m; re += v * this.cos[o + i]; im += v * this.sin[o + i]; }
      p[j] = re * re + im * im;
    }
    return p;
  }
}

/** Biquad notch (RBJ), retuned in place so its state carries on. */
function notchCoefs(q, fs, f0, bw) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), alpha = Math.sin(w) * Math.sinh(Math.LN2 / 2 * (bw / f0) * w / Math.sin(w)), a0 = 1 + alpha;
  Object.assign(q, { b0: 1 / a0, b1: -2 * c / a0, b2: 1 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0 });
}

/** Strongest peak of p (optionally weighted), refined by a parabola. Returns { j, f, share } or null. */
function pickPeak(sp, p, weight) {
  let best = -1, bj = -1, total = 0;
  for (let j = 0; j < p.length; j++) total += p[j];
  if (!(total > 0)) return null;
  for (let j = 1; j < p.length - 1; j++) {
    if (p[j] < p[j - 1] || p[j] < p[j + 1]) continue;
    const s = p[j] * (weight ? weight(sp.f[j], j) : 1);
    if (s > best) { best = s; bj = j; }
  }
  if (bj < 0) return null;
  const y0 = p[bj - 1], y1 = p[bj], y2 = p[bj + 1], d = y0 - 2 * y1 + y2, off = d ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / d)) : 0;
  const df = sp.f[1] - sp.f[0];
  // share of band power within ±0.1 Hz of the peak: 1 = one clean line, small = flat noise
  const span = Math.round(0.1 / df); let near = 0;
  for (let j = Math.max(0, bj - span); j <= Math.min(p.length - 1, bj + span); j++) near += p[j];
  return { j: bj, f: sp.f[bj] + off * df, share: near / total };
}

// ---------- the engine ----------
/**
 * layout: { ppg: [{ stream, ch }], ambient: { stream, ch } | null } names which recorded channels are
 * pulse channels (Polar: ppg 0..2, ambient ppg 3; SensWear: ppg green, ppg_ir, ppg_red).
 * o.onSample(t, s)   every grid sample: { raw, fused, clean, accG } for display
 * o.onBeat(t, y, ok) every detected beat; ok = false when it was rejected (impact, or off the tracked rate)
 * o.onEstimate(e)    once a second: see `estimate()` below
 * o.keepSpectra      keep each second's spectrum of the clean signal (post-processing)
 */
export function createMotionHr(cfgIn, layout, o = {}) {
  const cfg = mergeConfig(cfgIn), fs = FS, dt = 1 / fs, W = WINDOW_S * fs;
  const nCh = layout.ppg.length;
  const streams = new Map();     // key -> { t: [], v: [], ch, p }
  const want = new Set([...layout.ppg.map((c) => c.stream), ...(layout.ambient ? [layout.ambient.stream] : []), 'acc', 'gyro', 'mag']);
  const sp = new Spectrum(W);
  const bpLo = cfg.bandpass.on ? cfg.bandpass.lo : 0.3, bpHi = cfg.bandpass.on ? cfg.bandpass.hi : 5;
  const mkBp = () => new BandPass(fs, bpLo, Math.min(bpHi, fs / 2 - 0.5));
  let bpP, bpR, rings, cleanRing, accRings, nlmsW, refHist, refScale, notch, accScale = null;
  const fresh = () => {
    bpP = Array.from({ length: nCh }, mkBp); bpR = Array.from({ length: 9 }, mkBp);
    rings = Array.from({ length: nCh }, () => new Ring(W)); cleanRing = new Ring(W); accRings = [0, 1, 2].map(() => new Ring(W));
    nlmsW = new Float32Array(9 * cfg.nlms.taps); refHist = new Float32Array(9 * cfg.nlms.taps); refScale = new Float32Array(9);
    notch = new Biquad(1, 0, 0, 0, 0); notch.on = false;
  };
  fresh();
  let tg = null, gridN = 0;
  let wts = Array.from({ length: nCh }, (_, i) => (cfg.fusion.auto ? 1 / nCh : cfg.fusion.weights[i] ?? 0));
  const scale = new Float32Array(nCh).fill(0);   // running RMS per channel
  let amp = 0, y1 = 0, y2 = 0, t1 = null, lastBeat = null, freezeUntil = -Infinity, impacts = 0;
  const beats = [];              // [t, ok]
  let track = null, trackT = null, lastAnswerT = null, cadence = null, motionG = 0, nextEst = null;
  const challengers = [];        // last few unconstrained spectral picks, for re-acquiring a lost track
  const spectra = [];
  let lastP = null, lastAccP = null;   // the latest spectra, for the live spectrum plot

  function stream(key) { let s = streams.get(key); if (!s) streams.set(key, (s = { t: [], v: [], ch: 1, p: 0 })); return s; }
  /** Value of a stream at time t by linear interpolation, or null outside its data or across a gap. */
  function at(s, t, c) {
    const T = s.t;
    while (s.p + 1 < T.length && T[s.p + 1] <= t) s.p++;
    const i = s.p;
    if (!T.length || T[i] > t || i + 1 >= T.length) return null;
    const a = T[i], b = T[i + 1];
    if (b - a > 0.5) return null;
    const f = (t - a) / (b - a), ch = s.ch, v = s.v[i * ch + c] + (s.v[(i + 1) * ch + c] - s.v[i * ch + c]) * f;
    return Number.isFinite(v) ? v : null;   // a bad value is a gap, never a NaN that poisons every filter after it
  }
  const vec = (key, n = 3) => { const s = streams.get(key); if (!s || !s.t.length) return null; const out = []; for (let c = 0; c < n; c++) { const v = at(s, tg, c); if (v == null) return null; out.push(v); } return out; };

  /** One grid sample. */
  function step(t) {
    // 1-2 resample, ambient
    const amb = cfg.ambient.on && layout.ambient ? at(stream(layout.ambient.stream), t, layout.ambient.ch) : null;
    const y = new Float32Array(nCh);
    for (let c = 0; c < nCh; c++) {
      const L = layout.ppg[c], x = at(stream(L.stream), t, L.ch);
      if (x == null) return false;
      y[c] = -bpP[c].step(x - (amb ?? 0));                 // more blood, less light back: flip so a beat points up
      scale[c] += (y[c] * y[c] - scale[c]) * (gridN < fs ? 0.2 : 0.02);
      rings[c].push(y[c]);
    }
    const a = vec('acc'), g = vec('gyro'), m = vec('mag');
    // ACC arrives in mG (Polar, SensWear after decoding); guess once from gravity in case a source gives g
    if (a && accScale == null) accScale = Math.hypot(...a) > 50 ? 1000 : 1;
    const accG = a ? Math.hypot(...a) / accScale : null;
    if (accG != null && cfg.impact.on && accG > cfg.impact.g) { if (t > freezeUntil) impacts++; freezeUntil = t + cfg.impact.freeze; }
    const frozen = t < freezeUntil;
    // 4 fusion
    let fused = 0;
    if (cfg.fusion.on) for (let c = 0; c < nCh; c++) fused += wts[c] * y[c] / Math.sqrt(scale[c] || 1);
    else fused = y[0] / Math.sqrt(scale[0] || 1);
    // 5 NLMS on band-passed motion axes
    let clean = fused;
    const refs = [a, g, m], wk = [cfg.nlms.w.acc, cfg.nlms.w.gyro, cfg.nlms.w.mag], taps = cfg.nlms.taps;
    let haveRef = false;
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
      const j = r * 3 + k, h = j * taps;
      refHist.copyWithin(h + 1, h, h + taps - 1);
      // each axis scaled by its own running size, so mG, deg/s and gauss weigh alike before the weights
      const v = refs[r] ? bpR[j].step(refs[r][k]) : 0;
      if (r === 0 && refs[0]) accRings[k].push(v / accScale);
      if (refs[r]) refScale[j] += (v * v - refScale[j]) * (gridN < fs ? 0.2 : 0.01);
      refHist[h] = refs[r] && wk[r][k] ? (v / Math.sqrt(refScale[j] || 1)) * wk[r][k] : 0;
      if (refHist[h]) haveRef = true;
    }
    if (cfg.nlms.on && haveRef) {
      let pred = 0, pow = 1e-6;
      for (let j = 0; j < 9 * taps; j++) { pred += nlmsW[j] * refHist[j]; pow += refHist[j] * refHist[j]; }
      clean = fused - pred;
      if (!frozen) { const mu = cfg.nlms.mu / pow; for (let j = 0; j < 9 * taps; j++) nlmsW[j] += mu * clean * refHist[j]; }
    }
    // 6 cadence notch
    if (cfg.notch.on && notch.on) clean = notch.step(clean);
    cleanRing.push(clean);
    // beats on the clean signal
    amp += (Math.abs(clean) - amp) * (1 / (fs * 2));
    const scr = cfg.beats.on, prom = scr ? cfg.beats.minProm : 0.3;
    if (t1 != null && y1 > y2 && y1 >= clean && y1 > prom * amp && (lastBeat == null || t1 - lastBeat >= MIN_BEAT_S)) {
      // screening: no beat inside an impact freeze, none that implies a rate far off the tracked one
      const ok = !scr || (!(cfg.impact.on && frozen) && !(track && lastBeat != null && Math.abs(60 / (t1 - lastBeat) - track) > Math.max(25, cfg.beats.tol * track) && beats.length > 3));
      beats.push([t1, ok]); lastBeat = t1;
      o.onBeat?.(t1, y1, ok);
    }
    y2 = y1; y1 = clean; t1 = t;
    while (beats.length && beats[0][0] < t - WINDOW_S) beats.shift();
    o.onSample?.(t, { raw: y[0] / Math.sqrt(scale[0] || 1), fused, clean, accG });
    if (nextEst == null) nextEst = t + 1;
    if (t >= nextEst) { nextEst += 1; if (gridN >= W) estimate(t, frozen); }
    gridN++;
    return true;
  }

  const buf = new Float32Array(W);
  /** Once a second: fusion weights, cadence, spectral and beat HR, tracker, confidence. */
  function estimate(t, frozen) {
    // fusion weights from each channel's pulse to noise ratio around the tracked rate (or its own peak)
    if (cfg.fusion.on) {
      if (cfg.fusion.auto) {
        const snr = rings.map((r) => { const pk = pickPeak(sp, sp.of(r.copy(buf)), track ? (f) => Math.exp(-0.5 * ((f * 60 - track) / 12) ** 2) : null); return pk ? pk.share : 0; });
        const sum = snr.reduce((s, x) => s + x * x, 0);
        if (sum > 0) wts = wts.map((w, c) => w + ((snr[c] * snr[c]) / sum - w) * 0.3);
      } else wts = Array.from({ length: nCh }, (_, i) => cfg.fusion.weights[i] ?? 0);
    }
    // movement size and rhythm from the band-passed ACC axes (|a| hides sideways motion under gravity)
    let cadShare = 0;
    if (accRings[0].count >= W) {
      let s2 = 0, sum = null;
      for (const r of accRings) {
        const x = r.copy(buf); for (let i = 0; i < W; i++) s2 += x[i] * x[i];
        const p = sp.of(x); if (!sum) sum = p; else for (let j = 0; j < p.length; j++) sum[j] += p[j];
      }
      motionG = Math.sqrt(s2 / W);
      lastAccP = sum;
      const pk = pickPeak(sp, sum);
      cadence = pk && pk.share > 0.2 && motionG > cfg.notch.minG ? pk.f : null;
      cadShare = pk ? pk.share : 0;
    } else { motionG = 0; cadence = null; }
    // retune the notch: off when still, and never on the heart line
    const fTrack = track ? track / 60 : null;
    notch.on = !!(cfg.notch.on && cadence && (!fTrack || Math.abs(cadence - fTrack) > 0.15));
    if (notch.on) notchCoefs(notch, fs, cadence, cfg.notch.width * 2);
    // spectral HR on the clean window
    const p = sp.of(cleanRing.copy(buf));
    lastP = p;
    if (o.keepSpectra) spectra.push({ t, p });
    const since = trackT == null ? 0 : t - trackT;
    const sigma = track ? (cfg.tracker.maxStep * Math.max(1, since) + 8) / 60 : null;
    const near = (f) => !cfg.notch.on || !cadence || motionG < cfg.notch.minG ? 1 : (Math.abs(f - cadence) < cfg.notch.width || Math.abs(f - 2 * cadence) < cfg.notch.width) && (!fTrack || Math.abs(f - fTrack) > 0.15) ? 0.25 : 1;
    let spk = pickPeak(sp, p, (f) => near(f) * (sigma && cfg.tracker.on ? Math.exp(-0.5 * ((f - fTrack) / sigma) ** 2) : 1));
    // re-acquire: a free pick (no tracker prior) that stays put for 6 s, away from the track and stronger, takes over
    const free = pickPeak(sp, p, near);
    if (free) { challengers.push(free.f * 60); if (challengers.length > 6) challengers.shift(); }
    if (free && spk && track && challengers.length === 6 && Math.max(...challengers) - Math.min(...challengers) < 8
      && Math.abs(free.f * 60 - track) > 15 && free.share > 0.3 && free.share > spk.share * 1.2) { spk = free; track = null; }
    // no clear line (under ~10 % of the band power near the peak) is no answer: the tracker holds, then lets go
    const spec = spk && spk.share >= 0.1 ? { bpm: spk.f * 60, q: Math.min(1, spk.share * 1.6) } : null;
    // beat to beat
    const iv = []; for (let i = 1; i < beats.length; i++) if (beats[i][1] && beats[i - 1][1]) iv.push(beats[i][0] - beats[i - 1][0]);
    const pk = iv.length >= 2 ? estimateBpm(iv) : null;
    // blend
    let bpm = null, agree = 0, why = null;
    if (!cfg.estimate.on) why = 'HR estimate is switched off';
    else if (spec && pk) {
      if (Math.abs(spec.bpm - pk.bpm) <= 8) { const ws = cfg.estimate.spectral * spec.q, wp = cfg.estimate.peaks * pk.quality; bpm = (ws * spec.bpm + wp * pk.bpm) / ((ws + wp) || 1); agree = 1; }
      else bpm = cadence && Math.abs(spec.bpm - cadence * 60) < 6 && Math.abs(pk.bpm - cadence * 60) >= 6 ? pk.bpm : spec.bpm;  // beats suffer more from leftover motion
    } else if (spec && cfg.estimate.spectral > 0) bpm = spec.bpm;
    else if (pk && cfg.estimate.peaks > 0) bpm = pk.bpm;
    if (bpm == null && !why) why = 'no clear pulse in the last 8 s';
    // tracker
    if (bpm != null && cfg.tracker.on && track != null) { const lim = cfg.tracker.maxStep * Math.max(1, t - trackT); bpm = track + Math.max(-lim, Math.min(lim, bpm - track)); }
    if (bpm != null) { track = bpm; trackT = t; lastAnswerT = t; }
    else if (cfg.tracker.on && track != null && t - lastAnswerT <= cfg.tracker.hold) { bpm = track; why = `held: ${why}`; }
    else { track = null; trackT = null; }
    // confidence
    const motionPen = Math.min(1, motionG / 1.5);
    let conf = bpm == null ? 0 : 0.45 * (spec?.q ?? 0) + 0.25 * (pk?.quality ?? 0) + 0.2 * agree + 0.1 * (1 - motionPen);
    if (frozen && cfg.impact.on) { conf *= 0.5; why ||= 'impact: holding'; }
    const shown = bpm != null && (!cfg.gate.on || conf >= cfg.gate.min) ? bpm : null;
    if (bpm != null && shown == null) why = `confidence ${(conf * 100).toFixed(0)} % below the gate`;
    o.onEstimate?.({
      t, bpm: shown, tracked: bpm, conf, why, spec: spec?.bpm ?? null, specQ: spec?.q ?? 0, peaks: pk?.bpm ?? null, peaksQ: pk?.quality ?? 0,
      cadence: cadence && cadence * 60, cadShare, motionG, impacts, frozen, notchOn: notch.on, weights: [...wts], beats: beats.length,
    });
  }

  return {
    cfg, layout, spectra, freqs: sp.f,
    /** Latest spectra of the clean PPG and of the movement (ACC axes summed), or null before the first. */
    get spectrum() { return lastP && { f: sp.f, p: lastP, acc: lastAccP }; },
    /** Samples of one stream (t: seconds, v: flat values, ch per sample), in time order. */
    push(key, t, v, ch) {
      if (!want.has(key)) return;
      const s = stream(key); s.ch = ch;
      for (let i = 0; i < t.length; i++) {
        if (s.t.length && t[i] <= s.t[s.t.length - 1]) continue;
        s.t.push(t[i]); for (let c = 0; c < ch; c++) s.v.push(v[i * ch + c]);
      }
    },
    /** Run the grid up to where every live stream has data. Call after each batch of pushes. */
    run() {
      const pp = layout.ppg.map((c) => streams.get(c.stream));
      if (pp.some((s) => !s || s.t.length < 2)) return;
      let end = Math.min(...pp.map((s) => s.t[s.t.length - 1]));
      const lead = end;
      for (const k of ['acc', 'gyro', 'mag']) { const s = streams.get(k); if (s?.t.length && lead - s.t[s.t.length - 1] < 2) end = Math.min(end, s.t[s.t.length - 1]); }
      if (tg == null) tg = Math.max(...pp.map((s) => s.t[0]));
      while (tg <= end) {
        if (!step(tg)) {
          // PPG gap: restart filters at the next sample after it
          const nx = Math.max(...pp.map((s) => { const i = s.t.findIndex((x) => x > tg); return i < 0 ? Infinity : s.t[i]; }));
          if (!Number.isFinite(nx)) break;
          fresh(); amp = 0; y1 = y2 = 0; t1 = null; lastBeat = null; beats.length = 0; gridN = 0; nextEst = null; scale.fill(0);
          tg = nx; continue;
        }
        tg += dt;
      }
      // keep 2 s behind the grid
      for (const s of streams.values()) {
        let k = 0; while (k < s.t.length - 2 && s.t[k] < tg - 2) k++;
        if (k) { s.t.splice(0, k); s.v.splice(0, k * s.ch); s.p = Math.max(0, s.p - k); }
      }
    },
  };
}

/** Which recorded channels are pulse channels, by sensor kind. */
export function layoutFor(kind, ppgCh = 4) {
  if (kind === 'senswear') return { ppg: [{ stream: 'ppg', ch: 0 }, { stream: 'ppg_ir', ch: 0 }, { stream: 'ppg_red', ch: 0 }], ambient: null };
  return ppgCh >= 4 ? { ppg: [0, 1, 2].map((ch) => ({ stream: 'ppg', ch })), ambient: { stream: 'ppg', ch: 3 } } : { ppg: [{ stream: 'ppg', ch: 0 }], ambient: null };
}

/**
 * Post-processing: the most likely heart line through a run's spectra. Each second's spectrum is a
 * score per frequency; moving between seconds costs (change / step)^2, so the path follows the strongest
 * line that changes no faster than a heart can. Uses the whole run, future included.
 * Returns [{ t, bpm }].
 */
export function viterbi(spectra, freqs, step = 6) {
  const N = spectra.length, B = freqs.length;
  if (!N) return [];
  const df = (freqs[1] - freqs[0]) * 60, K = Math.ceil((3 * step) / df);
  const em = (p) => { let s = 0; for (const x of p) s += x; const out = new Float32Array(B); for (let j = 0; j < B; j++) out[j] = Math.log(p[j] / (s || 1) + 1e-6); return out; };
  let score = em(spectra[0].p);
  const back = [];
  for (let n = 1; n < N; n++) {
    const e = em(spectra[n].p), next = new Float32Array(B), bk = new Int16Array(B);
    const gapS = Math.max(1, spectra[n].t - spectra[n - 1].t), kk = Math.min(B, Math.ceil(K * gapS));
    for (let j = 0; j < B; j++) {
      let best = -Infinity, bi = j;
      for (let i = Math.max(0, j - kk); i <= Math.min(B - 1, j + kk); i++) { const d = ((i - j) * df) / (step * gapS), s = score[i] - d * d; if (s > best) { best = s; bi = i; } }
      next[j] = best + e[j]; bk[j] = bi;
    }
    score = next; back.push(bk);
  }
  let j = 0; for (let i = 1; i < B; i++) if (score[i] > score[j]) j = i;
  const path = new Array(N);
  for (let n = N - 1; n >= 0; n--) { path[n] = { t: spectra[n].t, bpm: freqs[j] * 60 }; if (n) j = back[n - 1][j]; }
  return path;
}

/**
 * Replays recorded streams through the live engine, then runs the Viterbi pass.
 * streams: { ppg: { t, v, ch }, acc, gyro, mag, ppg_ir, ppg_red } (any missing is fine).
 * Returns { est: [...per second], beats: [[t, y, ok]], clean: { t, v }, raw: { t, v }, accG: { t, v }, post: [{ t, bpm }] }.
 */
export function runOffline(streams, kind, cfg) {
  const layout = layoutFor(kind, streams.ppg?.ch || 1);
  const out = { est: [], beats: [], clean: { t: [], v: [] }, raw: { t: [], v: [] }, accG: { t: [], v: [] }, post: [] };
  const eng = createMotionHr(cfg, layout, {
    keepSpectra: true,
    onSample: (t, s) => { out.clean.t.push(t); out.clean.v.push(s.clean); out.raw.t.push(t); out.raw.v.push(s.raw); if (s.accG != null) { out.accG.t.push(t); out.accG.v.push(s.accG); } },
    onBeat: (t, y, ok) => out.beats.push([t, y, ok]),
    onEstimate: (e) => out.est.push(e),
  });
  // feed one second at a time across every stream, as the live page would see it
  const keys = Object.keys(streams).filter((k) => streams[k]?.t?.length);
  const idx = Object.fromEntries(keys.map((k) => [k, 0]));
  const t0 = Math.min(...keys.map((k) => streams[k].t[0])), t1 = Math.max(...keys.map((k) => streams[k].t[streams[k].t.length - 1]));
  for (let te = t0 + 1; te < t1 + 1; te += 1) {
    for (const k of keys) {
      const s = streams[k], i0 = idx[k]; let i = i0;
      while (i < s.t.length && s.t[i] < te) i++;
      if (i > i0) eng.push(k, s.t.slice(i0, i), s.v.slice(i0 * s.ch, i * s.ch), s.ch);
      idx[k] = i;
    }
    eng.run();
  }
  out.post = viterbi(eng.spectra, eng.freqs, cfg?.tracker?.maxStep ? Math.max(3, cfg.tracker.maxStep * 0.6) : 6);
  return out;
}

export { median };
