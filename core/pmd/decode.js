// PMD decoding (data frames, control point responses, settings, features) and the commands the dashboard writes.
// Mirrors polar-ble-sdk @ a693e9e944c9bc925addbdd8cf07fb9b28748bf7 (Android), paths relative to
// sources/Android/android-communications/library/src/main/java/com/polar/androidcommunications/api/ble/model/gatt/client/pmd/
// Pure ES module: Uint8Array/DataView only, runs in Chrome and Node.

import {
  MeasurementType as MT,
  MEASUREMENT_TYPE_MASK,
  MEASUREMENT_TYPE_NAME,
  FEATURES_RESPONSE_CODE,
  FEATURE_BITS,
  OpCode,
  OP_CODE_NAME,
  CP_RESPONSE_CODE,
  CP_MEASUREMENT_STOPPED,
  SettingType,
  SETTING_FIELD_SIZE,
  SETTING_KEY,
  ResponseStatus,
} from './constants.js';

const f32 = Math.fround;
const hex = (n) => '0x' + n.toString(16).padStart(2, '0');

export function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  throw new TypeError('expected Uint8Array, DataView, ArrayBuffer or byte array');
}

// Kotlin Float.toInt(): truncate toward zero, saturate, NaN -> 0.
function floatToInt(x) {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x);
}

// kotlin.math.round() is Math.rint: ties go to the even integer (JS Math.round sends them up).
function roundHalfEven(x) {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const scratch = new DataView(new ArrayBuffer(4));
export function bitsToFloat32(bits) {
  scratch.setInt32(0, bits);
  return scratch.getFloat32(0);
}

// TypeUtils.convertArrayToSignedInt: little endian, sign taken from the last byte.
function readIntLE(p, off, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v |= p[off + i] << (8 * i);
  if (n < 4 && p[off + n - 1] & 0x80) v |= -1 << (8 * n);
  return v | 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Frame header (PmdDataFrame.kt): [0] type (bits 0-5), [1..8] u64 LE ns since 2000-01-01 UTC of the LAST sample,
// [9] bit 7 = delta compressed, bits 0-6 = frame type. The SDK's frame type enum has 0-10, 13, 14 only; any other
// value fails the header parse there, so it fails here too.
const KNOWN_FRAME_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14]);

export function parseFrame(bytes) {
  const p = toUint8Array(bytes);
  if (p.length < 10) throw new Error(`PMD frame too short: ${p.length} bytes, the header needs 10`);
  const frameType = p[9] & 0x7f;
  if (!KNOWN_FRAME_TYPES.has(frameType)) {
    throw new Error(`PMD frame type ${hex(frameType)} (byte 9 = ${hex(p[9])}) is not a frame type the SDK knows`);
  }
  return {
    measType: p[0] & MEASUREMENT_TYPE_MASK,
    timestampNs: new DataView(p.buffer, p.byteOffset, 10).getBigUint64(1, true),
    frameType,
    compressed: (p[9] & 0x80) !== 0,
    payload: p.subarray(10),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Delta compression, BlePMDClient.kt parseDeltaFramesAll / parseDeltaFrameRefSamples / parseDeltaFrame.
// Payload: reference sample (channels x ceil(refBits/8) bytes, LE), then blocks of [bitWidth u8][sampleCount u8]
// + ceil(width*count*channels/8) bytes of deltas, packed LSB first (bit k of the stream = byte k>>3, bit k&7),
// channel-interleaved. Deltas are sign-extended with Int.MAX_VALUE shl (width-1) and accumulated in Int32.
export function decodeDeltaFrames(payload, channels, refBits, refSigned = true) {
  if (!(Number.isInteger(channels) && channels > 0 && Number.isInteger(refBits) && refBits >= 1 && refBits <= 32)) {
    throw new RangeError(`decodeDeltaFrames: channels ${channels} / refBits ${refBits} out of range`);
  }
  const p = toUint8Array(payload);
  const refBytes = Math.ceil(refBits / 8);
  const refLen = channels * refBytes;
  if (p.length < refLen) {
    throw new Error(`delta frame: reference sample needs ${refLen} bytes (${channels} ch x ${refBytes}), payload has ${p.length}`);
  }
  const blocks = [];
  let count = 1;
  for (let off = refLen; off < p.length;) {
    if (off + 2 > p.length) throw new Error(`delta frame truncated: block header at byte ${off} of ${p.length}`);
    const width = p[off];
    const n = p[off + 1];
    const len = Math.ceil((width * n * channels) / 8);
    if (off + 2 + len > p.length) {
      throw new Error(`delta frame truncated: block at byte ${off} (width ${width}, ${n} samples) needs ${len} bytes, ${p.length - off - 2} left`);
    }
    // Width 0 yields no samples in the SDK (iOS logs it as malformed); widths > 32 overflow its Int. Fail loud.
    if (n > 0 && (width === 0 || width > 32)) {
      throw new Error(`delta block at byte ${off}: bit width ${width} with ${n} samples cannot be decoded`);
    }
    blocks.push(off + 2, width, n);
    count += n;
    off += 2 + len;
  }

  const out = new Int32Array(count * channels);
  const mask = -1 << (refBits - 1);
  for (let c = 0; c < channels; c++) {
    if (refSigned) {
      const v = readIntLE(p, c * refBytes, refBytes);
      out[c] = v & mask ? v | mask : v; // then sign-extend at `resolution` bits
    } else {
      let v = 0; // FLOAT_IEEE754 references: raw bits, no sign handling
      for (let i = 0; i < refBytes; i++) v |= p[c * refBytes + i] << (8 * i);
      out[c] = v;
    }
  }
  let s = channels;
  for (let b = 0; b < blocks.length; b += 3) {
    const start = blocks[b];
    const width = blocks[b + 1];
    const n = blocks[b + 2];
    const signMask = (0x7fffffff << (width - 1)) | 0;
    let bit = start * 8;
    for (let i = 0; i < n * channels; i++, s++) {
      let v = 0;
      for (let k = 0; k < width; k++, bit++) if (p[bit >> 3] & (1 << (bit & 7))) v |= 1 << k;
      if (v & signMask) {
        // For width 1 the SDK mask is 0x7fffffff, so a set bit becomes +2147483647, not -1. Refuse to guess.
        if (width === 1) throw new Error(`delta block at byte ${start - 2}: 1-bit delta of 1 is decoded inconsistently by the SDK`);
        v |= signMask;
      }
      out[s] = (out[s - channels] + v) | 0;
    }
  }
  return { samples: out, count };
}

// ---------------------------------------------------------------------------------------------------------------
// Sample timestamps, model/PmdTimeStampUtils.kt getTimeStamps. prevNs = timestamp of the previous frame with the
// same (measType, frameType), 0n for the first frame after start. Double arithmetic on purpose: it is what the SDK
// does (so sample times near 2026 are quantised to 128 ns steps, exactly as in the SDK).
export function sampleTimestamps(prevNs, frameNs, count, sampleRateHz) {
  if (!(count > 0)) throw new Error(`sample timestamps: sample count is ${count}`);
  let delta;
  if (prevNs === 0n) {
    if (!(sampleRateHz > 0)) {
      throw new Error(`sample timestamps: first frame of a stream needs the sample rate, got ${sampleRateHz}`);
    }
    delta = (1.0 / sampleRateHz) * 1000 * 1000 * 1000;
  } else {
    const between = BigInt.asUintN(64, frameNs - prevNs); // ULong arithmetic, wraps like the SDK
    if (between === 0n) throw new Error(`sample timestamps: frame timestamp ${frameNs} equals the previous frame's`);
    delta = Number(between) / count;
  }
  const frame = Number(frameNs);
  if (frame < delta * count) {
    throw new Error(`sample timestamps would be negative: frame ${frameNs} ns, previous ${prevNs} ns, ${count} samples, step ${delta} ns`);
  }
  let start;
  if (prevNs === 0n) {
    start = frame - delta * (count - 1);
    if (!(start > 0)) throw new Error(`sample timestamps: first sample would be at ${start} ns`);
  } else {
    start = Number(prevNs) + delta;
  }
  const out = new BigUint64Array(count);
  for (let i = 0; i < count - 1; i++) out[i] = BigInt(roundHalfEven(start + delta * i));
  out[count - 1] = frameNs;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Frame layouts, one per (measType, compressed, frameType) the SDK decodes: model/PpgData.kt, AccData.kt,
// GyrData.kt, MagData.kt, PpiData.kt. The SDK takes channel count and reference size from here, never from the
// settings (Verity Sense reports PPG resolution 22 while the frames carry 24-bit references).
// value(sample, channel, factor) reproduces the SDK's Float32 factor arithmetic.
const seq = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
const XYZ = Object.freeze(['x', 'y', 'z']);
const PPG3_AMBIENT1 = Object.freeze(['ppg0', 'ppg1', 'ppg2', 'ambient']);
const always = (s, f) => floatToInt(f32(f32(s) * f));
const intIfNot1 = (s, f) => (f !== 1 ? floatToInt(f32(f32(s) * f)) : s);
const floatIfNot1 = (s, f) => (f !== 1 ? f32(f32(s) * f) : f32(s));
const calibration = (s) => (s >= -1 && s <= 3 ? s : -1); // MagData.CalibrationStatus.getById, -1 = NOT_AVAILABLE

const delta = (channels, refBits, names, unit, Values, value, refSigned = true) =>
  Object.freeze({ kind: 'delta', channels, refBits, refSigned, channelNames: Object.freeze(names), unit, Values, value });
const rawInts = (channels, bytes, names, unit) =>
  Object.freeze({ kind: 'rawInt', channels, bytes, channelNames: names, unit, Values: Int32Array });
const special = (names, unit, decode) => Object.freeze({ kind: 'special', channels: names.length, channelNames: Object.freeze(names), unit, decode });

const DELTA_LAYOUTS = {
  [MT.PPG]: {
    0: delta(4, 24, PPG3_AMBIENT1, 'counts', Int32Array, (s, c, f) => always(s, f)), // factor always applied
    7: delta(17, 24, [...seq('ppg', 16), 'status'], 'counts', Int32Array, (s, c, f) => (c < 16 ? intIfNot1(s, f) : s & 0xffffff)),
    8: delta(25, 24, [...seq('ppg', 24), 'status'], 'counts', Int32Array, (s, c, f) => (c < 24 ? intIfNot1(s, f) : s & 0xffffff)),
    10: delta(21, 24, [...seq('red', 8), ...seq('green', 6), ...seq('ir', 6), 'status'], 'counts', Int32Array, (s, c, f) => (c < 20 ? intIfNot1(s, f) : s)),
    13: delta(3, 24, ['ppg0', 'ppg1', 'status'], 'counts', Int32Array, (s, c, f) => (c < 2 ? intIfNot1(s, f) : s & 0xffffff)),
  },
  [MT.ACC]: {
    // Type 0 arrives in G; the SDK converts to mG with factor * 1000.
    0: delta(3, 16, XYZ, 'mG', Int32Array, (s, c, f) => floatToInt(f32(f32(s) * f32(f * 1000)))),
    1: delta(3, 16, XYZ, 'mG', Int32Array, (s, c, f) => intIfNot1(s, f)),
  },
  [MT.GYRO]: {
    0: delta(3, 16, XYZ, 'deg/s', Float32Array, (s, c, f) => floatIfNot1(s, f)),
    // Type 1: references are IEEE 754 bit patterns (not sign-extended); deltas are added to the bits.
    1: delta(3, 32, XYZ, 'deg/s', Float32Array, (s, c, f) => (f !== 1 ? f32(bitsToFloat32(s) * f) : bitsToFloat32(s)), false),
  },
  [MT.MAG]: {
    0: delta(3, 16, XYZ, 'G', Float32Array, (s, c, f) => floatIfNot1(s, f)),
    1: delta(4, 16, [...XYZ, 'calibrationStatus'], 'G', Float32Array, (s, c, f) => (c < 3 ? f32(floatIfNot1(s, f) / 1000) : calibration(s))),
  },
};

// PPG types 4 and 9 (12 timeslots) and 14 (1 timeslot): numInt bytes, then gain bytes alternating ch1/ch2, 3 bits.
function ppgGains(n) {
  return special([...seq('numInt', n), ...seq('ch1Gain', n), ...seq('ch2Gain', n)], null, (fr, ctx, L) =>
    fixedSize(fr, ctx, L, 3 * n, Int32Array, (p, o, out, j) => {
      for (let i = 0; i < n; i++) out[j + i] = p[o + i];
      for (let i = 0; i < 2 * n; i++) out[j + n + (i % 2) * n + (i >> 1)] = p[o + n + i] & 0x07;
    }),
  );
}

const RAW_LAYOUTS = {
  [MT.PPG]: {
    0: rawInts(4, 3, PPG3_AMBIENT1, 'counts'),
    4: ppgGains(12),
    5: special(['operationMode'], null, (fr, ctx, L) =>
      fixedSize(fr, ctx, L, 4, Uint32Array, (p, o, out, j) => { out[j] = (readIntLE(p, o, 4) >>> 0); })),
    6: special(['sportId'], null, decodeSportId),
    9: ppgGains(12),
    14: ppgGains(1),
  },
  [MT.ACC]: {
    0: rawInts(3, 1, XYZ, 'mG'), // online_measurement.pdf table 7: this one is G on Verity Sense; the SDK does not convert
    1: rawInts(3, 2, XYZ, 'mG'),
    2: rawInts(3, 3, XYZ, 'mG'),
  },
  [MT.PPI]: {
    0: special(['hr', 'ppMs', 'ppErrorMs', 'blocker', 'skinContact', 'skinContactSupported'], null, decodePpi),
  },
};
// Raw TYPE_10 has a parser in PpgData.kt but parseDataFromDataFrame never dispatches to it, so it is absent here.

export function frameLayout(measType, frameType, compressed) {
  return (compressed ? DELTA_LAYOUTS : RAW_LAYOUTS)[measType]?.[frameType] ?? null;
}

function result(fr, count, L, values, sampleTimestampsNs, extra) {
  return {
    measType: fr.measType,
    timestampNs: fr.timestampNs,
    frameType: fr.frameType,
    compressed: fr.compressed,
    count,
    channels: L.channels,
    channelNames: L.channelNames,
    unit: L.unit,
    values,
    sampleTimestampsNs,
    ...extra,
  };
}

function label(fr) {
  return `${MEASUREMENT_TYPE_NAME[fr.measType]} ${fr.compressed ? 'delta' : 'raw'} frame type ${hex(fr.frameType)}`;
}

function fixedSize(fr, ctx, L, size, Values, read) {
  const n = fr.payload.length;
  if (n === 0 || n % size !== 0) throw new Error(`${label(fr)}: payload of ${n} bytes is not a non-zero multiple of ${size}`);
  const count = n / size;
  const values = new Values(count * L.channels);
  for (let i = 0; i < count; i++) read(fr.payload, i * size, values, i * L.channels);
  return result(fr, count, L, values, sampleTimestamps(ctx.prevNs, fr.timestampNs, count, ctx.sampleRateHz));
}

function decodeSportId(fr, ctx, L) {
  const n = fr.payload.length;
  if (n < 8) throw new Error(`${label(fr)}: payload of ${n} bytes, sport id needs 8`);
  // The SDK computes timestamps for floor(n/8) samples and keeps only the first.
  const ts = sampleTimestamps(ctx.prevNs, fr.timestampNs, Math.floor(n / 8), ctx.sampleRateHz);
  const id = new DataView(fr.payload.buffer, fr.payload.byteOffset, 8).getBigUint64(0, true);
  return result(fr, 1, L, BigUint64Array.of(id), BigUint64Array.of(ts[0]));
}

// model/PpiData.kt: 6 bytes per sample. Sample times need no sample rate: the last sample gets the frame
// timestamp and each earlier one is the next one minus its successor's PP interval (all 0 if the frame says 0).
function decodePpi(fr, ctx, L) {
  const p = fr.payload;
  if (p.length === 0 || p.length % 6 !== 0) throw new Error(`${label(fr)}: payload of ${p.length} bytes is not a non-zero multiple of 6`);
  const count = p.length / 6;
  const values = new Int32Array(count * 6);
  const ppi = [];
  for (let i = 0, o = 0; i < count; i++, o += 6) {
    const s = {
      hr: p[o],
      ppMs: p[o + 1] | (p[o + 2] << 8),
      ppErrorMs: p[o + 3] | (p[o + 4] << 8),
      blocker: p[o + 5] & 0x01,
      skinContact: (p[o + 5] & 0x02) >> 1,
      skinContactSupported: (p[o + 5] & 0x04) >> 2,
    };
    ppi.push(s);
    values.set([s.hr, s.ppMs, s.ppErrorMs, s.blocker, s.skinContact, s.skinContactSupported], i * 6);
  }
  const ts = new BigUint64Array(count);
  if (fr.timestampNs !== 0n) {
    let t = fr.timestampNs;
    for (let i = count - 1; i >= 0; i--) {
      ts[i] = t;
      t = BigInt.asUintN(64, t - BigInt(ppi[i].ppMs) * 1000000n);
    }
  }
  return result(fr, count, L, values, ts, { ppi });
}

function normaliseCtx(ctx) {
  const prevNs = ctx.prevTimestampNs ?? 0n;
  if (typeof prevNs !== 'bigint') throw new TypeError(`ctx.prevTimestampNs must be a BigInt (ns), got ${typeof prevNs}`);
  const factor = ctx.factor ?? 1; // the SDK uses 1.0 when the start response carried no factor
  if (typeof factor !== 'number' || !Number.isFinite(factor)) throw new TypeError(`ctx.factor must be a finite number, got ${factor}`);
  const sampleRateHz = ctx.sampleRateHz ?? 0;
  if (typeof sampleRateHz !== 'number' || !(sampleRateHz >= 0)) throw new TypeError(`ctx.sampleRateHz must be a number >= 0, got ${sampleRateHz}`);
  return { prevNs, factor: f32(factor), sampleRateHz };
}

// ctx: { factor (from the START response, default 1), sampleRateHz (the requested rate, used only when
// prevTimestampNs is 0n), prevTimestampNs }. ctx.channels and ctx.resolution are accepted but not used: the SDK
// derives the layout from the frame type alone.
export function decodeFrame(bytes, ctx = {}) {
  const fr = parseFrame(bytes);
  const c = normaliseCtx(ctx);
  if (!DELTA_LAYOUTS[fr.measType] && !RAW_LAYOUTS[fr.measType]) {
    const name = MEASUREMENT_TYPE_NAME[fr.measType] ?? 'unknown';
    throw new Error(`PMD measurement type ${hex(fr.measType)} (${name}) is not decoded here; supported: PPG 0x01, ACC 0x02, PPI 0x03, GYRO 0x05, MAG 0x06`);
  }
  const L = frameLayout(fr.measType, fr.frameType, fr.compressed);
  if (!L) {
    throw new Error(`${MEASUREMENT_TYPE_NAME[fr.measType]} (${hex(fr.measType)}) ${fr.compressed ? 'delta compressed' : 'raw'} frame type ${hex(fr.frameType)} (byte 9 = ${hex(fr.frameType | (fr.compressed ? 0x80 : 0))}) is not decoded by the SDK`);
  }
  if (L.kind === 'special') return L.decode(fr, c, L);
  if (L.kind === 'rawInt') {
    return fixedSize(fr, c, L, L.channels * L.bytes, Int32Array, (p, o, out, j) => {
      for (let ch = 0; ch < L.channels; ch++) out[j + ch] = readIntLE(p, o + ch * L.bytes, L.bytes);
    });
  }
  if (fr.payload.length === 0) throw new Error(`${label(fr)}: empty payload`);
  const { samples, count } = decodeDeltaFrames(fr.payload, L.channels, L.refBits, L.refSigned);
  const ts = sampleTimestamps(c.prevNs, fr.timestampNs, count, c.sampleRateHz);
  const values = new L.Values(samples.length);
  for (let i = 0; i < samples.length; i++) values[i] = L.value(samples[i], i % L.channels, c.factor);
  return result(fr, count, L, values, ts);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings TLVs, PmdSetting.kt parsePmdSettingsData: [type][count] + count values of the type's field size, LE.
// Values are signed like the SDK (TypeUtils.convertArrayToSignedInt); FACTOR is returned as its float32 value.
export function parseSettings(bytes) {
  const p = toUint8Array(bytes);
  const out = {};
  if (p.length <= 1) return out; // the SDK ignores a lone byte (H10 start responses carry one reserved byte)
  for (let off = 0; off < p.length;) {
    const type = p[off];
    const size = SETTING_FIELD_SIZE[type];
    if (size === undefined) throw new Error(`PMD setting type ${hex(type)} at byte ${off} is unknown`);
    if (type === SettingType.SECURITY) throw new Error(`PMD setting type ${hex(type)} (SECURITY) is not parsed by the SDK`);
    if (off + 2 > p.length) throw new Error(`PMD settings truncated: no count byte for setting type ${hex(type)}`);
    const count = p[off + 1];
    off += 2;
    if (off + count * size > p.length) {
      throw new Error(`PMD settings truncated: setting type ${hex(type)} needs ${count * size} bytes at byte ${off}, ${p.length - off} left`);
    }
    const values = [];
    for (let i = 0; i < count; i++, off += size) {
      values.push(type === SettingType.FACTOR ? bitsToFloat32(readIntLE(p, off, 4)) : readIntLE(p, off, size));
    }
    out[SETTING_KEY[type]] = values; // a repeated type replaces the earlier one, as in the SDK's map
  }
  return out;
}

// Control point notification. 0xF0 = response to our command; 0x01 = the device stopped measurements itself.
// `more` (only on success) means further responses follow: concatenate their `parameters` and call
// parseSettings on the result. settings is parsed for GET_SETTINGS, START and GET_SDK_MODE_SETTINGS when
// complete; if parsing fails, settings is null and settingsError says why.
export function parseControlPointResponse(bytes) {
  const p = toUint8Array(bytes);
  if (p.length === 0) throw new Error('empty PMD control point notification');
  if (p[0] === CP_MEASUREMENT_STOPPED) {
    return { type: 'measurementStopped', measTypes: Array.from(p.subarray(1), (b) => b & MEASUREMENT_TYPE_MASK) };
  }
  if (p[0] !== CP_RESPONSE_CODE) {
    throw new Error(`PMD control point notification starts with ${hex(p[0])}: neither a response (0xf0) nor a stop notice (0x01)`);
  }
  if (p.length < 4) throw new Error(`PMD control point response too short: ${p.length} bytes, needs 4`);
  const opCode = p[1];
  const status = p[3];
  const [statusName, statusText] = ResponseStatus[status] ?? ['UNKNOWN_ERROR', `Unknown error code ${hex(status)} from the device.`];
  const success = status === 0;
  const more = success && p.length > 4 && p[4] !== 0;
  const parameters = success && p.length > 5 ? p.slice(5) : new Uint8Array(0);
  let settings = null;
  let settingsError = null;
  if (success && !more && (opCode === OpCode.GET_SETTINGS || opCode === OpCode.START || opCode === OpCode.GET_SDK_MODE_SETTINGS)) {
    try {
      settings = parseSettings(parameters);
    } catch (e) {
      settingsError = e.message;
    }
  }
  return {
    type: 'response',
    opCode,
    opName: OP_CODE_NAME[opCode] ?? null,
    measType: p[2] & MEASUREMENT_TYPE_MASK,
    status,
    statusName,
    statusText,
    success,
    more,
    parameters,
    settings,
    settingsError,
  };
}

// Control point READ value -> supported measurement types (PmdMeasurementType.fromByteArray).
export function parseFeatures(bytes) {
  const p = toUint8Array(bytes);
  if (p.length < 3 || p[0] !== FEATURES_RESPONSE_CODE) {
    throw new Error(`PMD features: expected 0x0f and 2 bitmask bytes, got ${p.length} bytes starting ${p.length ? hex(p[0]) : '(none)'}`);
  }
  return FEATURE_BITS.filter(([, i, mask]) => p[i] & mask).map(([type]) => type);
}

// ---------------------------------------------------------------------------------------------------------------
// Commands (online recording only: byte 1 bit 7 stays 0).
function checkMeasType(t) {
  if (!Number.isInteger(t) || t < 0 || t > MEASUREMENT_TYPE_MASK) throw new RangeError(`measurement type must be 0..63, got ${t}`);
}

export function buildGetSettings(measType, { sdkMode = false } = {}) {
  checkMeasType(measType);
  return Uint8Array.of(sdkMode ? OpCode.GET_SDK_MODE_SETTINGS : OpCode.GET_SETTINGS, measType);
}

// selected: one value per setting, e.g. { sampleRate: 52, resolution: 16, range: 8, channels: 3 }.
// Serialised as [type][1][value LE] in ascending type order (as in online_measurement.pdf p.14). factor is
// response-only and skipped like PmdSetting.serializeSelected does.
const START_SETTINGS = [SettingType.SAMPLE_RATE, SettingType.RESOLUTION, SettingType.RANGE, SettingType.RANGE_MILLIUNIT, SettingType.CHANNELS];
export function buildStart(measType, selected = {}) {
  checkMeasType(measType);
  const allowed = new Set(START_SETTINGS.map((t) => SETTING_KEY[t]).concat('factor'));
  for (const key of Object.keys(selected)) {
    if (!allowed.has(key)) throw new Error(`buildStart: "${key}" is not a setting the start command carries`);
  }
  const out = [OpCode.START, measType];
  for (const type of START_SETTINGS) {
    const v = selected[SETTING_KEY[type]];
    if (v === undefined || v === null) continue;
    const size = SETTING_FIELD_SIZE[type];
    const ok = Number.isInteger(v) && (size === 4 ? v >= -0x80000000 && v <= 0xffffffff : v >= 0 && v < 2 ** (8 * size));
    if (!ok) throw new RangeError(`buildStart: ${SETTING_KEY[type]} must be one integer that fits ${size} byte(s), got ${JSON.stringify(v)}`);
    out.push(type, 1);
    for (let i = 0; i < size; i++) out.push((v >>> (8 * i)) & 0xff);
  }
  return Uint8Array.from(out);
}

export function buildStop(measType) {
  checkMeasType(measType);
  return Uint8Array.of(OpCode.STOP, measType);
}
