// SensWear BLE protocol: service and characteristic UUIDs, payload decoders, and encoders for the
// values the GUI writes. Ported from SensWear's web-bluetooth-sdk @ a9217151 (src/uuids.ts,
// src/modules/*.ts), MIT licence, Copyright (c) Sensera Technologies: see LICENSE-senswear-web-bluetooth-sdk
// beside this file. Every multibyte value is little endian. Every decoder checks the payload length
// and throws on anything it cannot decode faithfully, as core/pmd/decode.js does for Polar.

const sig = (n) => `0000${n}-0000-1000-8000-00805f9b34fb`;

export const UUID = Object.freeze({
  DEVICE_INFO: sig('180a'), FIRMWARE_REVISION: sig('2a26'),
  CAPS_SERVICE: '9b8e0001-6b7d-4e9f-9b0d-2d7f6e5a4c30', CAPS: '9b8e0002-6b7d-4e9f-9b0d-2d7f6e5a4c30',
  BATTERY: sig('180f'), BATTERY_LEVEL: sig('2a19'), BATTERY_STATUS: sig('2bed'),
  TIME: sig('1805'), CURRENT_TIME: sig('2a2b'), LOCAL_TIME: sig('2a0f'), REFERENCE_TIME: sig('2a14'),
  THERMO: sig('1809'), TEMP_MEASUREMENT: sig('2a1c'), TEMP_TYPE: sig('2a1d'), TEMP_INTERVAL: sig('2a21'),
  LED: '3c688942-4143-470d-a798-4629803a1983', LED_COLOR: '3c688943-4143-470d-a798-4629803a1983',
  IMU: '7d2b6c10-9d78-4f3c-a122-6d2c4e6d2a11',
  IMU_QUAT: '7d2b6c11-9d78-4f3c-a122-6d2c4e6d2a11', IMU_ACC: '7d2b6c12-9d78-4f3c-a122-6d2c4e6d2a11',
  IMU_GYRO: '7d2b6c13-9d78-4f3c-a122-6d2c4e6d2a11', IMU_GESTURE: '7d2b6c14-9d78-4f3c-a122-6d2c4e6d2a11',
  IMU_ACTIVITY: '7d2b6c15-9d78-4f3c-a122-6d2c4e6d2a11',
  IMU_CONFIG: '7d2b6c20-9d78-4f3c-a122-6d2c4e6d2a11', IMU_ENABLE: '7d2b6c21-9d78-4f3c-a122-6d2c4e6d2a11',
  IMU_DRAIN_MS: '7d2b6c22-9d78-4f3c-a122-6d2c4e6d2a11',
  PPG: '029ca54e-d022-4583-b483-91e9ea77034a',
  PPG_RED: '029ca551-d022-4583-b483-91e9ea77034a', PPG_IR: '029ca552-d022-4583-b483-91e9ea77034a',
  PPG_GREEN: '029ca553-d022-4583-b483-91e9ea77034a',
  PPG_CONFIG: '029ca560-d022-4583-b483-91e9ea77034a', PPG_ENABLE: '029ca561-d022-4583-b483-91e9ea77034a',
  PPG_IRQ_PER_SAMPLE: '029ca562-d022-4583-b483-91e9ea77034a',
  TOUCH: '33a5eb3f-0e13-424f-8b7a-942be0ee5cfc', TOUCH_STATE: '33a5eb42-0e13-424f-8b7a-942be0ee5cfc',
  TOUCH_GESTURE: '33a5eb43-0e13-424f-8b7a-942be0ee5cfc', TOUCH_RAW: '33a5eb44-0e13-424f-8b7a-942be0ee5cfc',
  TOUCH_CONFIG: '33a5eb50-0e13-424f-8b7a-942be0ee5cfc', TOUCH_ENABLE: '33a5eb51-0e13-424f-8b7a-942be0ee5cfc',
  HAPTIC: 'daa05e91-f514-4a4e-8fc5-d1b80f25f24d', HAPTIC_PATTERN: 'daa05e92-f514-4a4e-8fc5-d1b80f25f24d',
});

/** Every service must be asked for in the chooser call, or Chrome blocks it for the whole session. */
export const SERVICES = Object.freeze([UUID.DEVICE_INFO, UUID.CAPS_SERVICE, UUID.BATTERY, UUID.TIME, UUID.THERMO,
  UUID.LED, UUID.IMU, UUID.IMU_CONFIG, UUID.PPG, UUID.PPG_CONFIG, UUID.TOUCH, UUID.TOUCH_CONFIG, UUID.HAPTIC]);

/** Advertised name prefixes: the SDK's two, plus the third spelling the quick start page lists. */
export const NAME_PREFIXES = Object.freeze(['Sens Wear', 'SensWear', 'SenseWear']);

export const PPG_ADC_MAX = 262143;            // 18 bit counts
export const ACC_LSB_PER_G = 4096;
export const Q14 = 16384;
export const SHIELD = Object.freeze({ haptic: 1, ppg: 2, temperature: 4, touch: 8 });
export const FEATURE = Object.freeze({ imu: 1, led: 2, haptic: 4, ppg: 8, temperature: 16, touch: 32, battery: 64, time: 128 });

function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  throw new TypeError('expected bytes');
}
const viewOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
function sized(v, n, what) {
  const b = bytesOf(v);
  if (b.length !== n) throw new Error(`${what}: ${b.length} bytes, expected ${n}`);
  return [b, viewOf(b)];
}
function bool(v, what) {
  const [b] = sized(v, 1, what);
  if (b[0] > 1) throw new Error(`${what}: ${b[0]} is not 0 or 1`);
  return b[0] === 1;
}

// ---------- streams ----------
/** One PPG colour, one sample per notification: device time in ms (u64) and raw 18 bit ADC counts. */
export function decodePpg(v) {
  const [, d] = sized(v, 12, 'PPG sample');
  return { tMs: d.getBigUint64(0, true), value: d.getUint32(8, true) };
}

/** Accelerometer and gyroscope: device time in µs (i64), three i16. ACC includes gravity, 4096 LSB per g;
 *  the gyro has no declared scale in the SDK, so it stays in raw units. */
export function decodeVector(v, what = 'IMU vector') {
  const [, d] = sized(v, 14, what);
  return { tUs: d.getBigInt64(0, true), x: d.getInt16(8, true), y: d.getInt16(10, true), z: d.getInt16(12, true) };
}

/** Orientation quaternion, Q14, and its accuracy estimate in radians (u16, Q14). */
export function decodeQuaternion(v) {
  const [, d] = sized(v, 18, 'IMU quaternion');
  return { tUs: d.getBigInt64(0, true), x: d.getInt16(8, true) / Q14, y: d.getInt16(10, true) / Q14,
    z: d.getInt16(12, true) / Q14, w: d.getInt16(14, true) / Q14, accuracyRad: d.getUint16(16, true) / Q14 };
}

export function decodeGesture(v) {
  const [b, d] = sized(v, 10, 'IMU gesture');
  return { tUs: d.getBigInt64(0, true), sensorId: b[8], gesture: b[9] };
}
export function decodeActivity(v) {
  const [b, d] = sized(v, 11, 'IMU activity');
  return { tUs: d.getBigInt64(0, true), sensorId: b[8], activity: b[9], transition: b[10] };
}

// Touch: the state record is packed (13 bytes), the raw record keeps the firmware struct's padding (16).
export function decodeTouchState(v) {
  const [b, d] = sized(v, 13, 'Touch state');
  if (b[8] > 1) throw new Error(`Touch state: touched flag ${b[8]}`);
  return { tUs: d.getBigInt64(0, true), touched: b[8] === 1, x: d.getUint16(9, true), y: d.getUint16(11, true) };
}
export function decodeTouchGesture(v) {
  const [b, d] = sized(v, 10, 'Touch gesture');
  return { tUs: d.getBigInt64(0, true), gesture: b[8], gestureState: b[9] };
}
export function decodeTouchRaw(v) {
  const [b, d] = sized(v, 16, 'Touch raw');
  if (b[8] > 1) throw new Error(`Touch raw: touched flag ${b[8]}`);
  return { tUs: d.getBigInt64(0, true), touched: b[8] === 1, x: d.getUint16(10, true), y: d.getUint16(12, true), touchState: b[14] };
}

// ---------- device, power, time, temperature ----------
export function decodeCapabilities(v) {
  const [b, d] = sized(v, 9, 'Device capabilities');
  const shields = d.getUint32(1, true), features = d.getUint32(5, true);
  const names = (mask, table) => Object.entries(table).filter(([, bit]) => (mask & bit) === bit).map(([k]) => k);
  return { protocol: b[0], shieldMask: shields, featureMask: features, shields: names(shields, SHIELD), features: names(features, FEATURE) };
}

export function decodeBatteryLevel(v) {
  const [b] = sized(v, 1, 'Battery level');
  if (b[0] > 100) throw new Error(`Battery level ${b[0]} is above 100`);
  return b[0];
}

/** Battery Level Status (0x2BED): flags, power state bit fields, level. */
export function decodePowerStatus(v) {
  const [b, d] = sized(v, 4, 'Battery level status');
  const p = d.getUint16(1, true);
  return {
    levelPresent: (b[0] & 2) !== 0, level: b[3], batteryPresent: (p & 1) === 1,
    wiredPower: (p >> 1) & 3, wirelessPower: (p >> 3) & 3, chargeState: (p >> 5) & 3, chargeLevel: (p >> 7) & 3,
    chargeType: (p >> 9) & 7, chargingFault: (p >> 12) & 15,
  };
}
export const POWER_SOURCE = ['not connected', 'connected', 'unknown', 'reserved'];
export const CHARGE_STATE = ['unknown', 'charging', 'discharging, active', 'discharging, inactive'];
export const CHARGE_LEVEL = ['unknown', 'good', 'low', 'critical'];

/** Current Time (0x2A2B), UTC. */
export function decodeCurrentTime(v) {
  const [b, d] = sized(v, 10, 'Current time');
  const year = d.getUint16(0, true);
  const t = new Date(Date.UTC(year, b[2] - 1, b[3], b[4], b[5], b[6], (b[8] * 1000) / 256));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== b[2] - 1 || t.getUTCDate() !== b[3] || t.getUTCHours() !== b[4]
    || t.getUTCMinutes() !== b[5] || t.getUTCSeconds() !== b[6] || b[7] < 1 || b[7] > 7) throw new Error('Current time: invalid date');
  return { date: t, dayOfWeek: b[7], fractions256: b[8], adjustReason: b[9] };
}
/** adjustReason 1 = manual update, 2 = external reference. */
export function encodeCurrentTime(date, adjustReason = 1) {
  const b = new Uint8Array(10), d = viewOf(b), dow = date.getUTCDay();
  d.setUint16(0, date.getUTCFullYear(), true);
  b.set([date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
    dow === 0 ? 7 : dow, Math.floor((date.getUTCMilliseconds() * 256) / 1000), adjustReason], 2);
  return b;
}

function ieee11073Float(raw) {
  let m = raw & 0x00ffffff;
  if ([0x007ffffe, 0x00800002, 0x007fffff, 0x00800000, 0x00800001].includes(m)) throw new Error(`Temperature: special value 0x${raw.toString(16)}`);
  if (m & 0x00800000) m -= 0x01000000;
  let e = (raw >>> 24) & 0xff;
  if (e & 0x80) e -= 0x100;
  return m * 10 ** e;
}

/** Health Thermometer measurement (0x2A1C), always returned in °C. */
export function decodeTemperature(v) {
  const b = bytesOf(v);
  if (b.length < 5) throw new Error(`Temperature: ${b.length} bytes, expected at least 5`);
  const d = viewOf(b), flags = b[0];
  let c = ieee11073Float(d.getUint32(1, true)), off = 5, time = null, type = null;
  if (flags & 1) c = ((c - 32) * 5) / 9;
  if (flags & 2) {
    if (b.length < off + 7) throw new Error('Temperature: time stamp truncated');
    const y = d.getUint16(off, true);
    time = new Date(Date.UTC(y, b[off + 2] - 1, b[off + 3], b[off + 4], b[off + 5], b[off + 6]));
    if (time.getUTCMonth() !== b[off + 2] - 1 || time.getUTCDate() !== b[off + 3]) throw new Error('Temperature: invalid time stamp');
    off += 7;
  }
  if (flags & 4) { if (b.length < off + 1) throw new Error('Temperature: type truncated'); type = b[off]; }
  return { celsius: c, time, type };
}

export function decodeU16(v, what) { const [, d] = sized(v, 2, what); return d.getUint16(0, true); }
export function decodeU32(v, what) { const [, d] = sized(v, 4, what); return d.getUint32(0, true); }
export const decodeBool = bool;

// ---------- writes ----------
export const encodeBool = (on) => Uint8Array.of(on ? 1 : 0);
export function encodeU32(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`${n} is not a u32`);
  const b = new Uint8Array(4); viewOf(b).setUint32(0, n, true); return b;
}
/** Temperature interval in seconds: 0 stops scheduled readings, else whole minutes from 60 to 65520. */
export function encodeTempInterval(s) {
  if (s !== 0 && (!Number.isInteger(s) || s < 60 || s > 65520 || s % 60)) throw new RangeError('interval must be 0, or whole minutes from 60 to 65520 s');
  const b = new Uint8Array(2); viewOf(b).setUint16(0, s, true); return b;
}

/** LED colour: firmware value 0x00RRGGBB, sent little endian as [BB, GG, RR, 00]. */
export const encodeLed = (r, g, b) => Uint8Array.of(b & 255, g & 255, r & 255, 0);
export function decodeLed(v) { const [b] = sized(v, 4, 'LED colour'); return { r: b[2], g: b[1], b: b[0] }; }

/** Haptic pattern v1: version 1, flags 0, frame count (u16), then per frame duration ms (u16) and intensity (u8). */
export function encodeHaptic(frames) {
  if (!frames.length || frames.length > 32) throw new RangeError('a haptic pattern has 1 to 32 frames');
  const b = new Uint8Array(4 + frames.length * 3), d = viewOf(b);
  b[0] = 1; b[1] = 0; d.setUint16(2, frames.length, true);
  frames.forEach(([ms, level], i) => {
    if (!Number.isInteger(ms) || ms < 1 || ms > 65535) throw new RangeError('frame duration must be 1 to 65535 ms');
    if (!Number.isInteger(level) || level < 0 || level > 255) throw new RangeError('frame intensity must be 0 to 255');
    d.setUint16(4 + i * 3, ms, true); b[6 + i * 3] = level;
  });
  return b;
}
