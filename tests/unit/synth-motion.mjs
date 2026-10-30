// Synthetic Polar Max mode run with a known heart rate, for tests/unit/motionhr.test.mjs and debugging.
// The motion artifact is a delayed, weighted copy of the ACC and GYRO movement, as in a real head hit or punch.
export const hrTrue = (t) => 145 + 15 * Math.sin((2 * Math.PI * t) / 120);           // 130 to 160 bpm
/** Polar Max mode shaped data: PPG 4 ch at 176 Hz (counts), ACC/GYRO at 208 Hz (mG, deg/s). */
export function makeRun(durS = 240, { artifact = 4, gapAt = null, impacts = [] } = {}) {
  const P = 1 / 176, M = 1 / 208;
  // movement: punches at a wandering 1.7 to 2.0 Hz plus slow head sway; artifact is a filtered copy of it
  const cad = (t) => 1.85 + 0.15 * Math.sin(t / 23);
  let ph = 0; const phase = []; for (let t = 0; t < durS + 1; t += 0.001) { phase.push(ph); ph += cad(t) * 0.001; }
  const ph_ = (t) => phase[Math.max(0, Math.min(phase.length - 1, Math.round(t * 1000)))];
  const ax = (t) => 900 * Math.sin(2 * Math.PI * ph_(t)) + 300 * Math.sin(2 * Math.PI * 2 * ph_(t) + 1);
  const ay = (t) => 500 * Math.sin(2 * Math.PI * ph_(t) + 0.7);
  const gz = (t) => 120 * Math.sin(2 * Math.PI * ph_(t) + 2.1);
  let bp = 0; const beat = []; for (let t = 0; t < durS + 1; t += 0.001) { beat.push(bp); bp += (hrTrue(t) / 60) * 0.001; }
  const pulse = (t) => { const p = beat[Math.min(beat.length - 1, Math.round(t * 1000))] % 1; return Math.exp(-((p - 0.2) ** 2) / 0.006) + 0.35 * Math.exp(-((p - 0.5) ** 2) / 0.015); };
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1; })();
  const ppg = { t: [], v: [], ch: 4 }, acc = { t: [], v: [], ch: 3 }, gyro = { t: [], v: [], ch: 3 };
  const art = (t) => artifact * 1000 * ((ax(t - 0.04) / 900) * 0.7 + (ay(t - 0.02) / 500) * 0.3 + (gz(t) / 120) * 0.4);
  for (let t = 0; t < durS; t += P) {
    if (gapAt && t > gapAt && t < gapAt + 3) continue;
    ppg.t.push(t);
    const amb = 9000 + 800 * Math.sin(t / 7);
    for (let c = 0; c < 3; c++) ppg.v.push(260000 * (1 - 0.1 * c) - 1000 * (1 - 0.1 * c) * pulse(t) + art(t) * (1 + 0.2 * c) + amb * 0.3 + 30 * rnd());
    ppg.v.push(amb);
  }
  for (let t = 0; t < durS; t += M) {
    acc.t.push(t); gyro.t.push(t);
    const hit = impacts.some((ti) => t >= ti && t < ti + 0.03) ? 8000 : 0;
    acc.v.push(ax(t) + hit, ay(t), 1000 + 20 * rnd()); gyro.v.push(5 * rnd(), 5 * rnd(), gz(t));
  }
  return { ppg, acc, gyro };
}

