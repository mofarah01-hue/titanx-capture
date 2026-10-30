// PC side heart rate from one raw PPG channel: band-pass, beat detection, then a rate from the beat to
// beat intervals of the last few seconds. It runs live in the page for both sensors (Polar green
// channel 0, SensWear green), so its number sits beside Polar's own HR on the same screen. It is a
// first engineering estimate, not Titan X's algorithm; the recorded CSVs keep the raw counts for that.

import { BandPass } from './filters.js';

export const WINDOW_S = 8;           // intervals used for one estimate
export const MIN_BEAT_S = 60 / 220;  // refractory: no two beats closer than this (220 bpm)

/**
 * From the beat to beat intervals (seconds, oldest first) of the last WINDOW_S seconds, the heart rate.
 * Return { bpm, quality } with quality from 0 (guess) to 1 (clean), or null when there is no honest answer.
 */
export function estimateBpm(intervals) {
  // Median first: one missed beat (an interval twice as long) or one extra beat (half as long) must not
  // move the answer. Intervals more than 20 % off the median are dropped, then the rest are averaged.
  const iv = intervals.filter((x) => x >= MIN_BEAT_S && x <= 2);      // 30 to 220 bpm
  if (iv.length < 3) return null;
  const s = [...iv].sort((a, b) => a - b), med = s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const good = iv.filter((x) => Math.abs(x - med) <= 0.2 * med);
  if (good.length < 3) return null;
  const mean = good.reduce((a, b) => a + b, 0) / good.length;
  const cv = Math.sqrt(good.reduce((a, b) => a + (b - mean) ** 2, 0) / good.length) / mean;
  // share of intervals kept, times regularity (a spread of 15 % of the interval or more scores 0)
  const quality = (good.length / intervals.length) * Math.max(0, 1 - cv / 0.15);
  if (quality < 0.2) return null;
  return { bpm: 60 / mean, quality: Math.round(quality * 100) / 100 };
}

/** One estimator per PPG stream and sample rate. push() returns an estimate about once a second.
 *  o.onSample(t, y) gets every band-passed sample and o.onBeat(t, y) every detected beat, for display. */
export function createHrEstimator(fs, o = {}) {
  const bp = new BandPass(fs, o.lo ?? 0.7, o.hi ?? 3.6);   // 42 to 216 bpm
  let y1 = 0, y2 = 0, t1 = null, amp = 0, lastBeat = null, lastReport = null, lastT = null;
  const beats = [];
  return {
    fs, status: null,
    push(t, x) {
      if (lastT != null && t - lastT > 3 / fs) { bp.reset(); y1 = y2 = 0; lastBeat = null; beats.length = 0; } // gap: start over
      lastT = t;
      const y = -bp.step(x);                                  // more blood, less light back: flip so a beat points up
      amp += (Math.abs(y) - amp) * Math.min(1, 1 / (fs * 2)); // running size of the pulse, about 2 s memory
      o.onSample?.(t, y);
      if (y1 > y2 && y1 >= y && y1 > 0.6 * amp && (lastBeat == null || t1 - lastBeat >= MIN_BEAT_S)) { beats.push(t1); lastBeat = t1; o.onBeat?.(t1, y1); }
      y2 = y1; y1 = y; t1 = t;
      while (beats.length && beats[0] < t - WINDOW_S) beats.shift();
      if (lastReport != null && t - lastReport < 1) return null;
      lastReport = t;
      const iv = []; for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1]);
      const r = iv.length ? estimateBpm(iv) : null;
      this.status = { beats: beats.length, why: r ? null : iv.length < 2 ? `${beats.length} beats in ${WINDOW_S} s` : `estimator gave no answer from ${beats.length} beats` };
      return r ? { t, bpm: r.bpm, quality: r.quality, beats: beats.length } : null;
    },
  };
}
