// SensWear payload decoders against the byte layouts and expected values of SensWear's own SDK tests
// (web-bluetooth-sdk @ a9217151, tests/protocol.test.ts). Inputs are built the way those tests build
// them, so a wrong offset, sign or byte order here disagrees with SensWear's reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../core/senswear/protocol.js';

const buf = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer), b); return b; };

// Catches the PPG timestamp read as signed or as µs, and the 18 bit value read from the wrong offset.
test('PPG sample: unsigned ms time stamp and full scale value (SDK vector)', () => {
  const s = P.decodePpg(buf(12, (d) => { d.setBigUint64(0, 1_725_000_000_123n, true); d.setUint32(8, P.PPG_ADC_MAX, true); }));
  assert.equal(s.tMs, 1_725_000_000_123n);
  assert.equal(s.value, 262143);
});

// Catches unsigned axis reads (negative motion turning into 60000 counts) and a wrong g scale.
test('IMU vector and quaternion: signed axes, 4096 LSB per g, Q14 (SDK vectors)', () => {
  const v = buf(14, (d) => { d.setBigInt64(0, 99n, true); d.setInt16(8, 4096, true); d.setInt16(10, -2048, true); d.setInt16(12, 1024, true); });
  const a = P.decodeVector(v);
  assert.deepEqual([a.x / P.ACC_LSB_PER_G, a.y / P.ACC_LSB_PER_G, a.z / P.ACC_LSB_PER_G], [1, -0.5, 0.25]);
  assert.deepEqual([a.x, a.y, a.z], [4096, -2048, 1024]);
  const q = P.decodeQuaternion(buf(18, (d) => {
    d.setBigInt64(0, 1_725_000_000_123_456n, true); d.setInt16(8, 8192, true); d.setInt16(10, -8192, true);
    d.setInt16(12, 0, true); d.setInt16(14, 16384, true); d.setUint16(16, 1024, true);
  }));
  assert.equal(q.tUs, 1_725_000_000_123_456n);
  assert.deepEqual([q.x, q.y, q.z, q.w], [0.5, -0.5, 0, 1]);
  assert.equal(q.accuracyRad, 0.0625);
});

// Catches a truncated or merged notification being decoded into garbage instead of being refused.
test('wrong payload lengths are refused', () => {
  assert.throws(() => P.decodePpg(new Uint8Array(11)), /12/);
  assert.throws(() => P.decodeVector(new Uint8Array(15)), /14/);
  assert.throws(() => P.decodeTouchRaw(new Uint8Array(15)), /16/);
});

// Catches power state bit fields shifted by one (charging shown as discharging, faults hidden).
test('Battery Level Status bit fields (SDK vector)', () => {
  const ps = 1 | (1 << 1) | (1 << 5) | (1 << 7) | (3 << 9) | (4 << 12);
  const s = P.decodePowerStatus([2, ps & 255, ps >> 8, 87]);
  assert.deepEqual([s.levelPresent, s.batteryPresent, s.wiredPower, s.chargeState, s.chargeLevel, s.chargeType, s.chargingFault, s.level],
    [true, true, 1, 1, 1, 3, 4, 87]);
  assert.throws(() => P.decodeBatteryLevel([101]));
});

// Catches the IEEE 11073 exponent read unsigned (36.63 °C shown as 3.6e256) and the time stamp offset.
test('Health Thermometer measurement with time stamp and type (SDK vector)', () => {
  const b = buf(13, (d, x) => { x[0] = 0x06; d.setUint32(1, (0xfe000000 | 3663) >>> 0, true); d.setUint16(5, 2026, true); x.set([7, 24, 12, 34, 56, 2], 7); });
  const t = P.decodeTemperature(b);
  assert.ok(Math.abs(t.celsius - 36.63) < 1e-9);
  assert.equal(t.time.toISOString(), '2026-07-24T12:34:56.000Z');
  assert.equal(t.type, 2);
  const special = b.slice(); new DataView(special.buffer).setUint32(1, 0x007fffff, true);
  assert.throws(() => P.decodeTemperature(special), /special/);
});

// Catches Sunday sent as day 0 (the firmware expects 1 to 7) and the fraction byte rounding.
test('Current Time round trip (SDK vector)', () => {
  const when = new Date(Date.UTC(2026, 6, 24, 12, 34, 56, 500));
  const r = P.decodeCurrentTime(P.encodeCurrentTime(when, 2));
  assert.equal(r.date.toISOString(), '2026-07-24T12:34:56.500Z');
  assert.deepEqual([r.dayOfWeek, r.fractions256, r.adjustReason], [5, 128, 2]);
  assert.equal(P.encodeCurrentTime(new Date(Date.UTC(2026, 9, 11)))[7], 7);
});

// Catches the LED colour sent as RGB instead of the firmware's little endian 0x00RRGGBB.
test('LED colour and haptic pattern bytes (SDK vectors)', () => {
  assert.deepEqual([...P.encodeLed(0x11, 0x22, 0x33)], [0x33, 0x22, 0x11, 0]);
  assert.deepEqual([...P.encodeHaptic([[100, 255], [50, 0]])], [1, 0, 2, 0, 100, 0, 255, 50, 0, 0]);
  assert.throws(() => P.encodeHaptic(Array.from({ length: 33 }, () => [1, 1])));
  assert.throws(() => P.encodeTempInterval(90));
});

// Catches touch records read with the wrong layout: state is packed, raw keeps struct padding (SDK vectors).
test('touch state (packed) and raw (padded) records', () => {
  const st = P.decodeTouchState(buf(13, (d, x) => { d.setBigInt64(0, 123n, true); x[8] = 1; d.setUint16(9, 4095, true); d.setUint16(11, 2048, true); }));
  assert.deepEqual([st.touched, st.x, st.y], [true, 4095, 2048]);
  const raw = P.decodeTouchRaw(buf(16, (d, x) => { d.setBigInt64(0, 125n, true); x[8] = 1; d.setUint16(10, 111, true); d.setUint16(12, 222, true); x[14] = 3; }));
  assert.deepEqual([raw.touched, raw.x, raw.y, raw.touchState], [true, 111, 222, 3]);
});

// Catches a shield or feature bit mapped to the wrong board (the GUI would offer controls that do not exist).
test('capabilities masks', () => {
  const c = P.decodeCapabilities(buf(9, (d, x) => { x[0] = 1; d.setUint32(1, P.SHIELD.ppg | P.SHIELD.temperature, true); d.setUint32(5, P.FEATURE.imu | P.FEATURE.ppg | P.FEATURE.battery, true); }));
  assert.deepEqual(c.shields, ['ppg', 'temperature']);
  assert.deepEqual(c.features, ['imu', 'ppg', 'battery']);
});

// ---------- MAX30101 register map ----------
import * as R from '../../core/senswear/max30101.js';

// Catches a field write that clobbers its neighbours: changing the sample rate must not touch the pulse width or range.
test('MAX30101 setField changes only its own bits', () => {
  const reg = 0b0_10_011_11;                                   // range 2, rate 3, pulse width 3
  const out = R.setField(reg, R.FIELDS.SPO2_SR, 6);
  assert.deepEqual([R.getField(out, R.FIELDS.SPO2_ADC_RGE), R.getField(out, R.FIELDS.SPO2_SR), R.getField(out, R.FIELDS.LED_PW)], [2, 6, 3]);
  assert.throws(() => R.setField(0, R.FIELDS.LED_PW, 4));
});

// Catches a slip in the compact allowed-settings arrays: checked against Tables 15 and 16 written out as the datasheet grid.
test('MAX30101 allowed rate and pulse width combinations match Tables 15 and 16', () => {
  const grid = { // rows 50..3200 sps, columns 69/118/215/411 µs, 1 = allowed (O in the datasheet)
    3: ['1111', '1111', '1111', '1111', '1110', '1100', '1000', '0000'],
    2: ['1111', '1111', '1111', '1111', '1111', '1111', '1110', '1000'],
  };
  for (const [mode, rows] of Object.entries(grid)) rows.forEach((row, sr) => [...row].forEach((o, pw) =>
    assert.equal(R.rateAllowed(Number(mode), sr, pw).ok, o === '1', `mode ${mode} sr ${sr} pw ${pw}`)));
});

// Catches the LED current shown in the wrong unit or step (the datasheet: 0x0F = 3.0 mA, 0xFF = 51.0 mA).
test('MAX30101 LED current codes', () => {
  assert.equal(R.paToMa(0x0f), 3.0);
  assert.ok(Math.abs(R.paToMa(0xff) - 51.0) < 1e-9);
  assert.equal(R.maToPa(12.6), 0x3f);
});

// Catches the multi LED check claiming more than the datasheet supports: the stock firmware's 3200 sps at 215 µs
// with three LEDs is above the two LED limit (800 sps, Table 15), and three LEDs at a lower rate are unknown, not "allowed".
test('MAX30101 multi LED rate check uses the two LED bound and admits what it does not know', () => {
  assert.equal(R.rateAllowed(7, 7, 2, 3).ok, false);   // stock firmware setting
  assert.equal(R.rateAllowed(7, 2, 2, 3).ok, null);    // 200 sps, three LEDs: not in the datasheet
  assert.equal(R.rateAllowed(7, 4, 2, 2).ok, true);    // 800 sps, two LEDs: Table 15
  assert.equal(R.rateAllowed(7, 7, 0, 1).ok, true);    // one LED behaves like heart rate mode: Table 16
});
