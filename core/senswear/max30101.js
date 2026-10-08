// MAX30101 register map for the SensWear register editor. Every value is from the MAX30101 datasheet
// (analog.com MAX30101.pdf, downloaded 2026-10-08): the register map table, the field tables on pp. 18
// to 21, the allowed rate and pulse width combinations in Tables 15 and 16, slot timing in Table 11.
// The editor reads and writes these over the debug board's shell; see core/senswear/shell.js.

export const I2C_ADDR = 0x57;          // 7 bit; the datasheet gives write 0xAE, read 0xAF
export const PART_ID = 0x15;           // register 0xFF

const tbl = (...rows) => rows.map(([code, text]) => ({ code, text }));

export const FIELDS = {
  SMP_AVE: { reg: 0x08, shift: 5, bits: 3, name: 'Samples averaged per FIFO sample',
    values: tbl([0, '1 (no averaging)'], [1, '2'], [2, '4'], [3, '8'], [4, '16'], [5, '32'], [6, '32'], [7, '32']) },
  FIFO_ROLLOVER_EN: { reg: 0x08, shift: 4, bits: 1, name: 'FIFO rolls over when full', values: tbl([0, 'off'], [1, 'on']) },
  FIFO_A_FULL: { reg: 0x08, shift: 0, bits: 4, name: 'FIFO almost full: empty samples left when the interrupt fires' },
  SHDN: { reg: 0x09, shift: 7, bits: 1, name: 'Shutdown', values: tbl([0, 'running'], [1, 'shut down']) },
  RESET: { reg: 0x09, shift: 6, bits: 1, name: 'Reset (self clearing)', values: tbl([0, ''], [1, 'reset now']) },
  MODE: { reg: 0x09, shift: 0, bits: 3, name: 'Mode',
    values: tbl([2, 'Heart rate mode, red only'], [3, 'SpO2 mode, red and IR'], [7, 'Multi LED mode, green, red and/or IR']) },
  SPO2_ADC_RGE: { reg: 0x0a, shift: 5, bits: 2, name: 'ADC full scale',
    values: tbl([0, '2048 nA (7.81 pA LSB)'], [1, '4096 nA (15.63 pA LSB)'], [2, '8192 nA (31.25 pA LSB)'], [3, '16384 nA (62.5 pA LSB)']) },
  SPO2_SR: { reg: 0x0a, shift: 2, bits: 3, name: 'Sample rate',
    values: tbl([0, '50 sps'], [1, '100 sps'], [2, '200 sps'], [3, '400 sps'], [4, '800 sps'], [5, '1000 sps'], [6, '1600 sps'], [7, '3200 sps']) },
  LED_PW: { reg: 0x0a, shift: 0, bits: 2, name: 'LED pulse width and ADC resolution',
    values: tbl([0, '69 µs, 15 bit'], [1, '118 µs, 16 bit'], [2, '215 µs, 17 bit'], [3, '411 µs, 18 bit']) },
  LED1_PA: { reg: 0x0c, shift: 0, bits: 8, name: 'LED1 (red) current', current: true },
  LED2_PA: { reg: 0x0d, shift: 0, bits: 8, name: 'LED2 (IR) current', current: true },
  LED3_PA: { reg: 0x0e, shift: 0, bits: 8, name: 'LED3 (green) current', current: true },
  LED4_PA: { reg: 0x0f, shift: 0, bits: 8, name: 'LED4 (green) current', current: true },
  SLOT1: { reg: 0x11, shift: 0, bits: 3, name: 'Slot 1 LED', values: slots() },
  SLOT2: { reg: 0x11, shift: 4, bits: 3, name: 'Slot 2 LED', values: slots() },
  SLOT3: { reg: 0x12, shift: 0, bits: 3, name: 'Slot 3 LED', values: slots() },
  SLOT4: { reg: 0x12, shift: 4, bits: 3, name: 'Slot 4 LED', values: slots() },
  TEMP_EN: { reg: 0x21, shift: 0, bits: 1, name: 'Start one die temperature reading (self clearing)' },
  REV_ID: { reg: 0xfe, shift: 0, bits: 8, name: 'Revision ID', readOnly: true },
  PART_ID: { reg: 0xff, shift: 0, bits: 8, name: 'Part ID (0x15)', readOnly: true },
};
function slots() { return tbl([0, 'off'], [1, 'LED1 red'], [2, 'LED2 IR'], [3, 'LED3 and LED4 green'], [4, 'off']); }

/** Registers in display order, with POR state from the register table. */
export const REGISTERS = [
  [0x00, 'Interrupt status 1', true], [0x01, 'Interrupt status 2', true], [0x02, 'Interrupt enable 1'], [0x03, 'Interrupt enable 2'],
  [0x04, 'FIFO write pointer'], [0x05, 'Overflow counter'], [0x06, 'FIFO read pointer'],
  [0x08, 'FIFO configuration'], [0x09, 'Mode configuration'], [0x0a, 'SpO2 configuration'],
  [0x0c, 'LED1 pulse amplitude'], [0x0d, 'LED2 pulse amplitude'], [0x0e, 'LED3 pulse amplitude'], [0x0f, 'LED4 pulse amplitude'],
  [0x11, 'Multi LED slots 1 and 2'], [0x12, 'Multi LED slots 3 and 4'],
  [0x1f, 'Die temperature integer', true], [0x20, 'Die temperature fraction', true], [0x21, 'Die temperature config'],
  [0xfe, 'Revision ID', true], [0xff, 'Part ID', true],
].map(([addr, name, readOnly = false]) => ({ addr, name, readOnly, fields: Object.entries(FIELDS).filter(([, f]) => f.reg === addr).map(([k]) => k) }));

export const getField = (regValue, f) => (regValue >> f.shift) & ((1 << f.bits) - 1);
export const setField = (regValue, f, v) => {
  const mask = ((1 << f.bits) - 1) << f.shift;
  if (v < 0 || v > (1 << f.bits) - 1) throw new RangeError(`value ${v} does not fit ${f.bits} bits`);
  return (regValue & ~mask & 0xff) | ((v << f.shift) & mask);
};

/** LEDx_PA: 0.2 mA per step, 0x00 = 0 mA, 0xFF = 51.0 mA (typical, p. 20). */
export const paToMa = (code) => code * 0.2;
export const maToPa = (mA) => Math.max(0, Math.min(255, Math.round(mA / 0.2)));

const SPS = [50, 100, 200, 400, 800, 1000, 1600, 3200];
const PW_US = [69, 118, 215, 411];
// Highest SPO2_SR code allowed for each LED_PW code (Tables 15 and 16). -1: none.
const MAX_SR = { spo2: [6, 5, 4, 3], hr: [7, 6, 6, 5] };

/**
 * Is this rate and pulse width combination allowed? The datasheet tables cover SpO2 mode (two LEDs,
 * Table 15) and heart rate mode (one LED, Table 16). Multi LED mode has no table; for it the answer
 * uses the one firm bound there is: one slot behaves like heart rate mode, and with two or more slots
 * the rate cannot exceed the two LED limit of Table 15. Within that bound, three or four slots are not
 * covered by the datasheet: ok is null and the rate must be measured.
 */
export function rateAllowed(mode, srCode, pwCode, activeSlots = 3) {
  if (mode === 3) return { ok: srCode <= MAX_SR.spo2[pwCode], source: 'Table 15' };
  if (mode === 2 || (mode === 7 && activeSlots <= 1)) return { ok: srCode <= MAX_SR.hr[pwCode], source: 'Table 16' };
  const cap = SPS[MAX_SR.spo2[pwCode]];
  if (srCode > MAX_SR.spo2[pwCode]) return { ok: false, source: `above ${cap} sps, the two LED limit at ${PW_US[pwCode]} µs in Table 15; ${activeSlots} LEDs can only be slower` };
  if (activeSlots === 2) return { ok: true, source: 'Table 15' };
  return { ok: null, source: `within the two LED limit of ${cap} sps (Table 15); the datasheet gives no limit for ${activeSlots} LEDs, so measure it` };
}
export const spsOf = (srCode) => SPS[srCode];
export const pwOf = (pwCode) => PW_US[pwCode];
