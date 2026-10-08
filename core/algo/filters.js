// Signal cleaning that runs on the PC, for any PPG stream (Polar or SensWear). Second order sections
// from the RBJ audio EQ cookbook (Robert Bristow-Johnson), Butterworth Q, run sample by sample so the
// live view and the recorder can share them. They assume evenly spaced samples at `fs`; call reset()
// after a gap, because a filter that runs across a gap rings.

const Q_BUTTER = Math.SQRT1_2;

export class Biquad {
  constructor(b0, b1, b2, a1, a2) { Object.assign(this, { b0, b1, b2, a1, a2 }); this.reset(); }
  reset() { this.z1 = 0; this.z2 = 0; this.primed = false; }
  /** Transposed direct form II. The first sample sets the state to the steady state for a constant
   *  input, so the large DC level of raw PPG counts does not make the filter ring at the start. */
  step(x) {
    if (!this.primed) {
      const y0 = ((this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2)) * x; // DC gain times x
      this.z2 = this.b2 * x - this.a2 * y0;
      this.z1 = this.b1 * x - this.a1 * y0 + this.z2;
      this.primed = true;
      return y0;
    }
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function design(kind, fs, f0, q = Q_BUTTER) {
  if (!(f0 > 0 && f0 < fs / 2)) throw new RangeError(`${kind} corner ${f0} Hz must be between 0 and ${fs / 2} Hz`);
  const w = (2 * Math.PI * f0) / fs, c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const [b0, b1, b2] = kind === 'low' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  return new Biquad(b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - alpha) / a0);
}
export const lowpass = (fs, f0) => design('low', fs, f0);
export const highpass = (fs, f0) => design('high', fs, f0);

/** Band-pass as a high-pass then a low-pass. 0.5 to 4 Hz keeps 30 to 240 bpm. */
export class BandPass {
  constructor(fs, lo = 0.5, hi = 4) { this.fs = fs; this.lo = lo; this.hi = hi; this.hp = highpass(fs, lo); this.lp = lowpass(fs, hi); }
  reset() { this.hp.reset(); this.lp.reset(); }
  step(x) { return this.lp.step(this.hp.step(x)); }
}
