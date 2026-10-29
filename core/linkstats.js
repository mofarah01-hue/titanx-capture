// Arrival statistics for one notification stream (one BLE characteristic), from receive times only:
// packets per second, interval mean, jitter (standard deviation of the intervals), 95th percentile and
// longest interval, stalls (intervals longer than `stallMs`) and time since the last packet. It never
// looks at packet contents; sensor time stamps, lost samples and out of order counts come from the
// capture worker. Times are performance.now() milliseconds.

export class ArrivalStats {
  constructor({ windowMs = 10000, stallMs = 250 } = {}) {
    this.windowMs = windowMs; this.stallMs = stallMs;
    this.t = [];          // receive times inside the window
    this.total = 0; this.stalls = 0; this.longest = 0;   // since reset(), not windowed
    this.last = null;
  }
  reset() { this.t = []; this.total = 0; this.stalls = 0; this.longest = 0; this.last = null; }

  add(ms) {
    if (this.last != null) {
      const d = ms - this.last;
      if (d > this.stallMs) this.stalls++;
      if (d > this.longest) this.longest = d;
    }
    this.last = ms; this.total++;
    this.t.push(ms);
    const cut = ms - this.windowMs;
    if (this.t[0] < cut) { let k = 0; while (k < this.t.length && this.t[k] < cut) k++; this.t.splice(0, k); }
  }

  /** Numbers for the window ending at `nowMs`; null where there are too few packets to say. */
  read(nowMs) {
    const t = this.t, n = t.length;
    const sinceLast = this.last == null ? null : nowMs - this.last;
    // A stream that stopped has no rate, whatever its old window says.
    if (n < 2 || sinceLast > this.windowMs) return { rate: n && sinceLast <= this.windowMs ? null : 0, mean: null, jitter: null, p95: null, max: null, sinceLast, total: this.total, stalls: this.stalls, longest: this.longest || null };
    const iv = new Float64Array(n - 1);
    let s = 0;
    for (let i = 1; i < n; i++) { iv[i - 1] = t[i] - t[i - 1]; s += iv[i - 1]; }
    const mean = s / iv.length;
    let q = 0; for (const d of iv) q += (d - mean) ** 2;
    const sorted = iv.slice().sort();
    // Rate over the span the packets cover, not the window length, so the first seconds are not under-read.
    const span = t[n - 1] - t[0];
    return {
      rate: span > 0 ? ((n - 1) * 1000) / span : null, mean, jitter: Math.sqrt(q / iv.length),
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted[sorted.length - 1],
      sinceLast, total: this.total, stalls: this.stalls, longest: this.longest,
    };
  }
}
