// Signal models for ?sim=N. Pure functions of (sensor, time), so any window can be regenerated
// exactly and a test can compare what was recorded against the truth. Units match what the
// decoder produces from a real Verity Sense: PPG raw counts, ACC in mG, GYRO in deg/s.
// Shapes are plausible, not physiological truth; they exist to exercise the app.

const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const nz = (n) => hash(n) * 2 - 1;
function vn(x, seed) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return nz(i + seed * 1013) * (1 - u) + nz(i + 1 + seed * 1013) * u; }

// A wrestling practice: warm up, drilling, live bouts with rests. [start s, intensity 0..1]
const SCRIPT = [[0, .12], [240, .35], [600, .55], [900, .92], [1080, .42], [1260, .95], [1440, .48], [1620, .7], [1980, .97], [2160, .5], [2400, .88], [2580, .45]];
const N = 4 * 3600;
const INT = new Float32Array(N);
{
  let I = .1, j = 0;
  for (let s = 0; s < N; s++) {
    while (j + 1 < SCRIPT.length && SCRIPT[j + 1][0] <= s) j++;
    const target = s < 2700 ? SCRIPT[j][1] : .5 + .4 * Math.sin(s / 170); // after the script: keep cycling
    I += (target - I) / 28; INT[s] = I;
  }
}
export function intensity(t) { t = Math.max(0, Math.min(N - 2, t)); const i = Math.floor(t), f = t - i; return INT[i] + (INT[i + 1] - INT[i]) * f; }

/**
 * One simulated wearer. `k` scales effort (1 = typical), `rest`/`max` in bpm, `seed` varies noise.
 * All time arguments are seconds since the simulated sensor started.
 */
export function createWearer({ seed = 1, rest = 58, max = 195, k = 1 } = {}) {
  const hrAt = (t) => rest + (max - rest - 6) * intensity(t) * k + 4 * vn(t / 9, seed) + 1.5 * Math.sin(t / 7 + seed);
  // cumulative beat phase at 1 Hz so the pulse train stays continuous as HR changes
  const P = new Float64Array(N);
  for (let i = 1; i < N; i++) P[i] = P[i - 1] + hrAt(i - 1) / 60;
  const phase = (t) => { t = Math.max(0, Math.min(N - 2, t)); const i = Math.floor(t); return P[i] + (t - i) * hrAt(i) / 60; };
  const motion = (t) => intensity(t) * Math.pow(Math.max(0, Math.sin(t * 2 * Math.PI / 9 + seed * 1.7)), 6);
  const pulse = (p) => { const g = (x, m, w) => Math.exp(-((x - m) * (x - m)) / (2 * w * w)); return g(p, .18, .055) + .38 * g(p, .46, .09) + .12 * g(p, .64, .12); };

  return {
    hrAt,
    /** Beat times (s) in [t0, t1): where the phase crosses an integer. */
    beats(t0, t1) {
      const out = [];
      let n = Math.ceil(phase(t0));
      for (let t = t0; t < t1; t += 0.002) { if (phase(t) >= n) { out.push(t); n++; } }
      return out;
    },
    /** PPG raw counts for channels 0..2 (green) and 3 (ambient). Blood volume lowers the reading. */
    ppg(t, ch, i = 0) {
      if (ch === 3) return Math.round(9000 + 1500 * Math.sin(t * 2 * Math.PI / 40) + 300 * vn(t * .5, seed + 9) + 40 * nz(i + 5));
      const ph = phase(t), p = ph - Math.floor(ph);
      const gain = [1, .86, .72][ch];
      return Math.round(260000 * gain - 3200 * gain * pulse(p) + 2200 * Math.sin(t * 2 * Math.PI / 6.5 + seed + ch)
        + 9000 * motion(t) * vn(t * 3.1, seed + ch) + 60 * nz(i * 3 + ch));
    },
    /** ACC in mG, head upright means gravity mostly on one axis. */
    acc(t, axis, i = 0) {
      const m = motion(t), g = [0, 0, 1000][axis] + [120, -80, 0][axis];
      return Math.round(g + 1600 * m * vn(t * 6 + axis * 11, seed + 3) + 12 * nz(i * 3 + axis + 11));
    },
    /** GYRO in deg/s. */
    gyro(t, axis, i = 0) {
      return +(260 * motion(t) * vn(t * 4 + axis * 7, seed + 5) + 1.5 * nz(i * 3 + axis + 17)).toFixed(3);
    },
    /** MAG in gauss (Earth's field is about 0.25 to 0.65 G), turning as the head turns. */
    mag(t, axis, i = 0) {
      return +([0.28, -0.14, 0.4][axis] * Math.cos(t / 4 + seed + axis * 1.3) + 0.05 * vn(t * 0.3 + axis * 5, seed + 13) + 0.002 * nz(i * 3 + axis + 23)).toFixed(4);
    },
    battery(t, start = 85) { return Math.max(1, Math.round(start - t / 600)); },
  };
}

/** Deterministic dropout plan: sensor index -> list of [from s, to s] with no radio link at all. */
export function dropoutsFor(index) {
  return [[[150, 156]], [[400, 412.5]], [], [[95, 98], [700, 760]], [[1000, 1003]], [], []][index % 7];
}
/** Fraction of packets lost at random while connected, per sensor index. */
export function lossFor(index) { return [0, 0.002, 0, 0.02, 0, 0.005, 0][index % 7]; }
