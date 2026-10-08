// PC side signal cleaning: the band-pass against the textbook answer for a second order Butterworth pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BandPass } from '../../core/algo/filters.js';

const FS = 200;
function gainAt(f) {
  const bp = new BandPass(FS); let peak = 0;
  for (let i = 0; i < FS * 30; i++) { const y = bp.step(100000 + Math.sin((2 * Math.PI * f * i) / FS)); if (i > FS * 20) peak = Math.max(peak, Math.abs(y)); }
  return peak;
}

// Catches a wrong coefficient formula or a swapped high and low pass: a Butterworth section is -3 dB (0.707) at its corner.
test('band-pass is -3 dB at 0.5 and 4 Hz and passes 1.5 Hz', () => {
  assert.ok(Math.abs(gainAt(0.5) - Math.SQRT1_2) < 0.02, `0.5 Hz: ${gainAt(0.5)}`);
  assert.ok(Math.abs(gainAt(4) - Math.SQRT1_2) < 0.02, `4 Hz: ${gainAt(4)}`);
  assert.ok(gainAt(1.5) > 0.95);
  assert.ok(gainAt(0.05) < 0.02 && gainAt(20) < 0.05);
});

// Catches the start-up transient: raw PPG sits at about 250000 counts, and an unprimed high-pass would swing by that much.
test('a constant raw level gives no start-up ringing', () => {
  const bp = new BandPass(FS);
  for (let i = 0; i < 2 * FS; i++) assert.ok(Math.abs(bp.step(250000)) < 1e-6);
});
