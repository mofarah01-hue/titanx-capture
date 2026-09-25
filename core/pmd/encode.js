// PMD encoding, used ONLY by the simulator so simulated traffic goes through the real decoder (decode.js).
// Byte layouts are the inverse of decode.js; see that file for the SDK sources.

import {
  MeasurementType as MT,
  MEASUREMENT_TYPE_MASK,
  FEATURES_RESPONSE_CODE,
  FEATURE_BITS,
  OpCode,
  CP_RESPONSE_CODE,
  CP_MEASUREMENT_STOPPED,
  SettingType,
  SETTING_FIELD_SIZE,
  SETTING_KEY,
} from './constants.js';
import { frameLayout } from './decode.js';

const f32 = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));
const float32ToBits = (x) => (scratch.setFloat32(0, x), scratch.getInt32(0));

function header(measType, timestampNs, frameType, compressed) {
  if (!Number.isInteger(measType) || measType < 0 || measType > MEASUREMENT_TYPE_MASK) throw new RangeError(`measType must be 0..63, got ${measType}`);
  if (!Number.isInteger(frameType) || frameType < 0 || frameType > 0x7f) throw new RangeError(`frameType must be 0..127, got ${frameType}`);
  if (typeof timestampNs !== 'bigint' || timestampNs < 0n || timestampNs >= 1n << 64n) throw new TypeError('timestampNs must be a BigInt in [0, 2^64)');
  const h = new Uint8Array(10);
  h[0] = measType;
  new DataView(h.buffer).setBigUint64(1, timestampNs, true);
  h[9] = frameType | (compressed ? 0x80 : 0);
  return h;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// Smallest two's complement width holding d. Width 2 is the floor: the SDK decodes a set 1-bit delta as
// +0x7fffffff and a 0-bit block as zero samples, so a device-faithful encoder must never rely on either.
const bitsFor = (d) => Math.max(2, 33 - Math.clz32(d < 0 ? ~d : d));

// samples: Int32Array (or numbers) interleaved by channel; the first sample becomes the reference, written in
// ceil(refBits/8) bytes. Blocks start at the width of their first delta and widen while widening costs fewer bits
// than a new 2-byte block header; a block holds at most 255 samples.
export function encodeDeltaFrames(samples, channels, refBits) {
  const s = Int32Array.from(samples);
  if (!(channels > 0) || s.length === 0 || s.length % channels !== 0) throw new Error(`encodeDeltaFrames: ${s.length} values is not a non-zero multiple of ${channels} channels`);
  const n = s.length / channels;
  const refBytes = Math.ceil(refBits / 8);
  const d = (i, c) => (s[i * channels + c] - s[(i - 1) * channels + c]) | 0;
  const width = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    let w = 0;
    for (let c = 0; c < channels; c++) w = Math.max(w, bitsFor(d(i, c)));
    width[i] = w;
  }
  const blocks = [];
  for (let i = 1; i < n;) {
    let w = width[i];
    let j = i + 1;
    while (j < n && j - i < 255) {
      if (width[j] <= w) j++;
      else if ((width[j] - w) * (j - i) * channels <= 16) (w = width[j]), j++;
      else break;
    }
    blocks.push([i, j, w]);
    i = j;
  }
  let size = channels * refBytes;
  for (const [a, b, w] of blocks) size += 2 + Math.ceil(((b - a) * w * channels) / 8);
  const out = new Uint8Array(size);
  let off = 0;
  for (let c = 0; c < channels; c++) for (let k = 0; k < refBytes; k++) out[off++] = (s[c] >>> (8 * k)) & 0xff;
  for (const [a, b, w] of blocks) {
    out[off] = w;
    out[off + 1] = b - a;
    let bit = (off + 2) * 8;
    for (let i = a; i < b; i++) {
      for (let c = 0; c < channels; c++) {
        const v = d(i, c);
        for (let k = 0; k < w; k++, bit++) if ((v >>> k) & 1) out[bit >> 3] |= 1 << (bit & 7);
      }
    }
    off += 2 + Math.ceil(((b - a) * w * channels) / 8);
  }
  return out;
}

// Linear gain the SDK applies to channel c of a delta layout; only used for the first guess in toWire.
function gainOf(L, measType, frameType, c, f) {
  if (L.channelNames[c] === 'status' || L.channelNames[c] === 'calibrationStatus') return 1;
  if (measType === MT.ACC && frameType === 0) return f32(f * 1000);
  if (measType === MT.MAG && frameType === 1) return f / 1000;
  return f;
}

// Wire integer whose decoded value (the decoder's own arithmetic) is closest to v; exact whenever v is reachable.
function toWire(L, measType, frameType, v, c, f) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`value ${v} is not a finite number`);
  if (L.refSigned === false) {
    const bits = float32ToBits(f32(f !== 1 ? v / f : v));
    return [bits - 1, bits, bits + 1].reduce((best, r) => (Math.abs(L.value(r, c, f) - v) < Math.abs(L.value(best, c, f) - v) ? r : best), bits);
  }
  let est = Math.round(v / gainOf(L, measType, frameType, c, f));
  if (L.channelNames[c] === 'status' && est > 0x7fffff) est -= 0x1000000; // decoder reads status back & 0xffffff
  let best = est;
  for (const r of [est - 1, est + 1, est - 2, est + 2]) if (Math.abs(L.value(r, c, f) - v) < Math.abs(L.value(best, c, f) - v)) best = r;
  if (/status$/i.test(L.channelNames[c]) && L.value(best, c, f) !== v) {
    throw new RangeError(`encodeFrame: ${L.channelNames[c]} ${v} cannot be represented in this frame type`);
  }
  return best;
}

// values: interleaved by channel, in the units decodeFrame returns for this frame type (mG, deg/s, G, counts) and
// computed with `factor` (the factor the simulated START response advertises). They are mapped to wire integers
// by inverting the SDK arithmetic, so decodeFrame(encodeFrame(x)).values == x whenever x is representable, and
// the nearest representable value otherwise. resolution (optional) bounds the wire integers to that many signed
// bits, like a device's ADC (e.g. 22 for Verity Sense PPG). Supports every delta layout the SDK decodes and the
// raw signed-int layouts (PPG 0x00, ACC 0x00-0x02); PPI frames go through encodePpiFrame.
export function encodeFrame({ measType, timestampNs, frameType, compressed, channels, resolution, factor = 1, values }) {
  const L = frameLayout(measType, frameType, compressed);
  if (!L || L.kind === 'special') throw new Error(`encodeFrame: measType ${measType} frame type ${frameType} (${compressed ? 'delta' : 'raw'}) is not supported by the encoder`);
  if (channels !== undefined && channels !== L.channels) throw new Error(`encodeFrame: frame type carries ${L.channels} channels, caller says ${channels}`);
  if (!values || values.length === 0 || values.length % L.channels !== 0) throw new Error(`encodeFrame: need a non-zero multiple of ${L.channels} values`);
  const f = f32(factor);
  const bits = resolution ?? (L.kind === 'delta' ? L.refBits : 8 * L.bytes);
  const lo = -(2 ** (bits - 1));
  const hi = 2 ** (bits - 1) - 1;
  const wire = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % L.channels;
    const w = L.kind === 'delta' ? toWire(L, measType, frameType, values[i], c, f) : values[i];
    if (!Number.isInteger(w) || (L.refSigned !== false && (w < lo || w > hi))) {
      throw new RangeError(`encodeFrame: value ${values[i]} (channel ${L.channelNames[c]}) maps to wire ${w}, outside ${bits}-bit signed range`);
    }
    wire[i] = w;
  }
  let payload;
  if (L.kind === 'delta') {
    payload = encodeDeltaFrames(wire, L.channels, L.refBits);
  } else {
    payload = new Uint8Array(wire.length * L.bytes);
    for (let i = 0; i < wire.length; i++) for (let k = 0; k < L.bytes; k++) payload[i * L.bytes + k] = (wire[i] >>> (8 * k)) & 0xff;
  }
  return concat(header(measType, timestampNs, frameType, compressed), payload);
}

// samples: [{ hr, ppMs, ppErrorMs, blocker, skinContact, skinContactSupported }] (flags as 0/1 or booleans).
// The decoder gives the last sample timestampNs and walks back by PP interval.
export function encodePpiFrame({ timestampNs, samples }) {
  if (!samples?.length) throw new Error('encodePpiFrame: need at least one sample');
  const p = new Uint8Array(samples.length * 6);
  samples.forEach((s, i) => {
    const o = i * 6;
    for (const [k, max] of [['hr', 0xff], ['ppMs', 0xffff], ['ppErrorMs', 0xffff]]) {
      if (!Number.isInteger(s[k]) || s[k] < 0 || s[k] > max) throw new RangeError(`encodePpiFrame: sample ${i} ${k}=${s[k]} outside 0..${max}`);
    }
    p[o] = s.hr;
    p[o + 1] = s.ppMs & 0xff;
    p[o + 2] = s.ppMs >> 8;
    p[o + 3] = s.ppErrorMs & 0xff;
    p[o + 4] = s.ppErrorMs >> 8;
    p[o + 5] = (s.blocker ? 1 : 0) | (s.skinContact ? 2 : 0) | (s.skinContactSupported ? 4 : 0);
  });
  return concat(header(MT.PPI, timestampNs, 0, false), p);
}

// Standard Heart Rate Measurement 0x2A37. RR intervals given in ms are sent in 1/1024 s units (each integer ms
// survives the round trip: 1/1024 s is finer than 1 ms).
export function encodeHeartRateMeasurement({ hr, sensorContact = false, sensorContactSupported = false, energyKj = null, rrMs = [] }) {
  if (!Number.isInteger(hr) || hr < 0 || hr > 0xffff) throw new RangeError(`hr must be 0..65535, got ${hr}`);
  const uint16 = hr > 0xff;
  const bytes = [0];
  let flags = uint16 ? 0x01 : 0;
  if (sensorContactSupported) flags |= sensorContact ? 0x06 : 0x04;
  bytes.push(hr & 0xff);
  if (uint16) bytes.push(hr >> 8);
  if (energyKj !== null) {
    if (!Number.isInteger(energyKj) || energyKj < 0 || energyKj > 0xffff) throw new RangeError(`energyKj must be 0..65535, got ${energyKj}`);
    flags |= 0x08;
    bytes.push(energyKj & 0xff, energyKj >> 8);
  }
  if (rrMs.length) {
    flags |= 0x10;
    for (const ms of rrMs) {
      const rr = Math.round((ms * 1024) / 1000);
      if (!(rr >= 0 && rr <= 0xffff)) throw new RangeError(`RR ${ms} ms does not fit 16 bits of 1/1024 s`);
      bytes.push(rr & 0xff, rr >> 8);
    }
  }
  bytes[0] = flags;
  return Uint8Array.from(bytes);
}

// Settings TLVs, the inverse of parseSettings. settings: { sampleRate: [52], resolution: [16], factor: [2.44e-4], ... }
// (single numbers accepted). Written in ascending type order; factor as IEEE 754 float32.
export function encodeSettings(settings) {
  const keyToType = Object.fromEntries(Object.entries(SETTING_KEY).map(([t, k]) => [k, Number(t)]));
  const types = Object.keys(settings).map((k) => {
    if (keyToType[k] === undefined || keyToType[k] === SettingType.SECURITY) throw new Error(`encodeSettings: unsupported setting "${k}"`);
    return keyToType[k];
  });
  const out = [];
  for (const type of types.sort((a, b) => a - b)) {
    const list = [].concat(settings[SETTING_KEY[type]]);
    const size = SETTING_FIELD_SIZE[type];
    out.push(type, list.length);
    for (const v of list) {
      const n = type === SettingType.FACTOR ? float32ToBits(v) : v;
      if (!Number.isInteger(n)) throw new TypeError(`encodeSettings: ${SETTING_KEY[type]} value ${v} is not an integer`);
      for (let i = 0; i < size; i++) out.push((n >>> (8 * i)) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function buildControlPointResponse({ opCode, measType, status = 0, more = false, parameters = new Uint8Array(0) }) {
  return Uint8Array.from([CP_RESPONSE_CODE, opCode, measType, status, more ? 1 : 0, ...parameters]);
}

// Full response to GET_SETTINGS (or GET_SDK_MODE_SETTINGS via opCode). For START, send
// buildControlPointResponse({ opCode: OpCode.START, measType, parameters: encodeSettings({ factor: [f] }) }).
export function buildSettingsResponse(measType, settings, { opCode = OpCode.GET_SETTINGS } = {}) {
  return buildControlPointResponse({ opCode, measType, parameters: encodeSettings(settings) });
}

// Control point READ value. 17 bytes like the Verity Sense example in online_measurement.pdf p.12.
export function encodeFeatures(measTypes) {
  const out = new Uint8Array(17);
  out[0] = FEATURES_RESPONSE_CODE;
  for (const t of measTypes) {
    const bit = FEATURE_BITS.find(([type]) => type === t);
    if (!bit) throw new Error(`encodeFeatures: measurement type ${t} has no feature bit`);
    out[bit[1]] |= bit[2];
  }
  return out;
}

// Device-initiated "online measurement stopped" control point notification.
export function encodeMeasurementStopped(measTypes) {
  return Uint8Array.from([CP_MEASUREMENT_STOPPED, ...measTypes]);
}
