// Motion robust HR against a known answer. Failure modes each test is here to catch:
// - motion bigger than the pulse at a cadence away from HR wins the spectral pick (HR locks onto movement)
// - the tracker cannot follow a real HR change of 30 bpm in a minute
// - a missed or extra beat moves the beat to beat rate
// - a gap in the PPG breaks the engine instead of restarting it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOffline, defaultConfig, viterbi } from '../../core/algo/motionhr.js';
import { estimateBpm } from '../../core/algo/hr.js';
import { maxHrOf, zoneOf } from '../../core/registry.js';

import { hrTrue, makeRun } from './synth-motion.mjs';

/** Mean absolute error of answered seconds after a 20 s warm up, and the share of seconds answered. */
function score(est) {
  const e = est.filter((x) => x.t > 20);
  const ans = e.filter((x) => x.bpm != null);
  const mae = ans.reduce((s, x) => s + Math.abs(x.bpm - hrTrue(x.t)), 0) / (ans.length || 1);
  return { mae, coverage: ans.length / (e.length || 1) };
}

test('HR under motion 4x the pulse: within 4 bpm with motion removal, clearly worse without', () => {
  const run = makeRun(240);
  const on = score(runOffline(run, 'polar', defaultConfig()).est);
  const cfgOff = defaultConfig(); cfgOff.nlms.on = false; cfgOff.notch.on = false; cfgOff.gate.on = false;
  const off = score(runOffline(run, 'polar', cfgOff).est);
  console.log(`motion removal on: MAE ${on.mae.toFixed(2)} bpm, answered ${(on.coverage * 100).toFixed(0)} %; off: MAE ${off.mae.toFixed(2)} bpm`);
  assert.ok(on.mae < 4, `MAE with motion removal ${on.mae.toFixed(2)} bpm`);
  assert.ok(on.coverage > 0.8, `answered only ${(on.coverage * 100).toFixed(0)} % of seconds`);
  assert.ok(off.mae > on.mae * 2, `without motion removal MAE ${off.mae.toFixed(2)} should be far worse than ${on.mae.toFixed(2)}`);
});

test('post-processing (Viterbi) follows the true HR line', () => {
  const r = runOffline(makeRun(240), 'polar', defaultConfig());
  const e = r.post.filter((x) => x.t > 20);
  const mae = e.reduce((s, x) => s + Math.abs(x.bpm - hrTrue(x.t)), 0) / e.length;
  console.log(`post-processed MAE ${mae.toFixed(2)} bpm over ${e.length} s`);
  assert.ok(mae < 4, `post MAE ${mae.toFixed(2)}`);
});

test('a 3 s PPG gap and impacts: engine restarts and answers again within 15 s', () => {
  const r = runOffline(makeRun(120, { gapAt: 60, impacts: [30, 31, 90] }), 'polar', defaultConfig());
  const after = r.est.filter((x) => x.t > 78 && x.bpm != null);
  assert.ok(after.length > 20, `only ${after.length} answers after the gap`);
  assert.ok(r.est.at(-1).impacts >= 3, `impacts counted ${r.est.at(-1).impacts}`);
  assert.ok(r.beats.some((b) => !b[2]), 'beats inside an impact freeze are marked rejected');
});

test('beat to beat: a missed beat or an extra beat does not move the rate; chaos gives no answer', () => {
  const iv = [0.5, 0.5, 0.5, 1.0, 0.5, 0.5, 0.25, 0.25, 0.5, 0.5];   // 120 bpm with one miss and one extra
  const r = estimateBpm(iv);
  assert.ok(r && Math.abs(r.bpm - 120) < 1, `got ${r?.bpm}`);
  assert.equal(estimateBpm([0.3, 0.9, 0.45, 1.3, 0.6, 0.35]), null);
  assert.equal(estimateBpm([0.5, 0.5]), null);
});

test('zones: Tanaka max from age, measured max wins, Polar 50/60/70/80/90 % bands', () => {
  const today = new Date('2026-10-30');
  assert.equal(maxHrOf({ birthYear: 1996 }, today), 187);            // 208 - 0.7 x 30
  assert.equal(maxHrOf({ birthYear: 1996, maxHr: 195 }, today), 195);
  assert.deepEqual([90, 100, 120, 140, 160, 180].map((h) => zoneOf(h, 200)), [0, 1, 2, 3, 4, 5]);
});

test('viterbi on a flat spectrum with one moving line picks the line', () => {
  const freqs = Float32Array.from({ length: 120 }, (_, j) => 0.6 + j * 0.025);
  const sp = Array.from({ length: 60 }, (_, n) => ({ t: n, p: Float32Array.from(freqs, (f) => (Math.abs(f - (2 + n * 0.005)) < 0.02 ? 50 : 1)) }));
  const path = viterbi(sp, freqs);
  assert.ok(path.every((x, n) => Math.abs(x.bpm / 60 - (2 + n * 0.005)) < 0.03));
});
