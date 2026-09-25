// PMD protocol layer checked against Polar SDK vectors (tests/fixtures/pmd, see each fixture's `source`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseFrame, decodeFrame, decodeDeltaFrames, sampleTimestamps, frameLayout, parseControlPointResponse,
  parseSettings, parseFeatures, buildGetSettings, buildStart, buildStop,
} from '../../core/pmd/decode.js';
import {
  encodeDeltaFrames, encodeFrame, encodePpiFrame, encodeHeartRateMeasurement, encodeSettings,
  buildControlPointResponse, buildSettingsResponse, encodeFeatures,
} from '../../core/pmd/encode.js';
import { parseHeartRateMeasurement } from '../../core/ble/gatt-parse.js';
import { MeasurementType as MT, OpCode } from '../../core/pmd/constants.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/pmd/${name}`, import.meta.url), 'utf8'));
const frames = fixture('frames.json');
const deltas = fixture('delta.json');
const stamps = fixture('timestamps.json');
const cp = fixture('control-point.json');

const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const f32FromBits = (hex) => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, parseInt(hex, 16));
  return dv.getFloat32(0);
};
const escape = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
// settings expectations may hold { f32: bits } for float values
const settingsWanted = (o) => JSON.parse(JSON.stringify(o), (k, v) => (v && typeof v === 'object' && 'f32' in v ? f32FromBits(v.f32) : v));

// Catches everything the SDK's own frame vectors expose: bit order, sign extension, block walking, factor
// arithmetic, channel layout and sample timestamps. Each fixture's `catches` names its specific bug.
test('decodeFrame reproduces the SDK frame vectors', async (t) => {
  for (const f of frames.frames) {
    await t.test(f.name, () => {
      const ctx = { factor: f.ctx.factor, sampleRateHz: f.ctx.sampleRateHz, prevTimestampNs: BigInt(f.ctx.prevTimestampNs) };
      const r = decodeFrame(bytes(f.hex), ctx);
      const e = f.expect;
      for (const k of ['measType', 'frameType', 'compressed', 'count', 'channels']) if (k in e) assert.equal(r[k], e[k], k);
      if (e.timestampNs) assert.equal(r.timestampNs, BigInt(e.timestampNs));
      assert.equal(r.values.length, r.count * r.channels);
      for (const [s, c, want, tol] of e.values ?? []) {
        const got = r.values[s * r.channels + c];
        if (typeof want === 'object') assert.equal(got, f32FromBits(want.f32), `sample ${s} channel ${c}`);
        else if (tol) assert.ok(Math.abs(got - want) <= tol, `sample ${s} channel ${c}: ${got} vs ${want}`);
        else assert.equal(got, want, `sample ${s} channel ${c}`);
      }
      if (e.allAbsLe) assert.ok(r.values.every((v) => Math.abs(v) <= e.allAbsLe));
      for (const [i, ns] of e.timestamps ?? []) assert.equal(r.sampleTimestampsNs[i], BigInt(ns), `timestamp of sample ${i}`);
      if (e.ppi) assert.deepEqual(r.ppi, e.ppi);
    });
  }
});

// Catches garbage returned for frames the SDK rejects: unknown types, compressed flag ignored, empty or partial
// payloads, short headers. The message must name the offending type in hex.
test('decodeFrame throws where the SDK rejects the frame', async (t) => {
  for (const f of frames.errors) {
    await t.test(f.name, () => {
      assert.throws(() => decodeFrame(bytes(f.hex), { sampleRateHz: 52, prevTimestampNs: 0n }), { message: escape(f.throws) });
    });
  }
});

// Catches a layout that fits the synthetic SDK vectors but not the real device: Polar's own Verity Sense ACC frame
// (0x80) must decode to the reference and deltas the document spells out.
test('Verity Sense ACC frame from Polar documentation', () => {
  for (const f of frames.docFrames) {
    const fr = parseFrame(bytes(f.hex));
    const e = f.expect;
    assert.deepEqual([fr.measType, fr.timestampNs, fr.frameType, fr.compressed], [e.measType, BigInt(e.timestampNs), e.frameType, e.compressed]);
    const L = frameLayout(fr.measType, fr.frameType, fr.compressed);
    const { samples, count } = decodeDeltaFrames(fr.payload, L.channels, L.refBits, L.refSigned);
    assert.equal(count, e.rawSamples.length);
    assert.deepEqual(Array.from(samples), e.rawSamples.flat());
  }
});

// Catches reference sign handling (signed vs float bits), 28/32-bit widths, Int32 wrap-around and block offsets
// across nine blocks.
test('decodeDeltaFrames reproduces the SDK parser vectors', async (t) => {
  for (const v of deltas.vectors) {
    await t.test(v.name, () => {
      const { samples, count } = decodeDeltaFrames(bytes(v.hex), v.channels, v.refBits, v.refSigned);
      assert.equal(count, v.expect.count);
      for (const [s, want] of Object.entries(v.expect.samples)) {
        assert.deepEqual(Array.from(samples.subarray(s * v.channels, (+s + 1) * v.channels)), want, `sample ${s}`);
      }
    });
  }
});

// Catches the wrong first-sample rule (rate vs previous timestamp), JS half-up rounding instead of Kotlin's
// half-even, and missing errors when times cannot be computed.
test('sampleTimestamps reproduces the PmdTimeStampUtils vectors', async (t) => {
  for (const v of stamps.vectors) {
    await t.test(v.name, () => {
      const run = () => sampleTimestamps(BigInt(v.prevNs), BigInt(v.frameNs), v.count, v.sampleRateHz);
      if (v.throws) assert.throws(run, { message: escape(v.throws) });
      else assert.deepEqual(Array.from(run()), v.expect.map(BigInt));
    });
  }
});

// Catches silent sample loss or garbage on blocks the SDK mishandles (width 0, width 1 with a set bit, width > 32)
// and misalignment after an empty block. No SDK vector exists: behaviour derived from parseDeltaFramesAll.
test('delta blocks the SDK cannot decode faithfully fail loud', () => {
  const ref = '010002000300'; // 3 channels of 16 bits: 1, 2, 3
  const dec = (h) => Array.from(decodeDeltaFrames(bytes(ref + h), 3, 16, true).samples);
  assert.throws(() => dec('0005'), /bit width 0 with 5 samples/);
  assert.deepEqual(dec('010100'), [1, 2, 3, 1, 2, 3]); // 1-bit block of zeros is fine in the SDK too
  assert.throws(() => dec('010101'), /1-bit delta/);
  assert.throws(() => dec('2101' + '00'.repeat(13)), /bit width 33/);
  assert.deepEqual(dec('0800' + '020135'), [1, 2, 3, 2, 3, 2]); // empty block, then deltas +1 +1 -1 in 2 bits
});

// Catches PPI sample times assigned forward or from a sample rate instead of walking back from the frame
// timestamp by PP interval (model/PpiData.kt); the SDK test uses timestamp 0, so it does not cover this.
test('PPI sample times walk back from the frame timestamp', () => {
  const f = frames.frames.find((x) => x.name === 'PPI raw type 0');
  const b = bytes(f.hex);
  new DataView(b.buffer).setBigUint64(1, 10_000_000_000n, true);
  assert.deepEqual(Array.from(decodeFrame(b).sampleTimestampsNs), [10_000_000_000n - 1_000_000n, 10_000_000_000n]);
});

// Catches the factor being applied to raw frames; the SDK applies it only to delta frames.
test('raw frames ignore the factor', () => {
  const f = frames.frames.find((x) => x.name === 'ACC raw type 1');
  const r = decodeFrame(bytes(f.hex), { factor: 2.44e-4, sampleRateHz: 52, prevTimestampNs: 0n });
  for (const [s, c, want] of f.expect.values) assert.equal(r.values[s * 3 + c], want);
});

// Catches wrong offsets for status/more/parameters, wrong status names, the factor read as an integer, and device
// stop notices mistaken for responses.
test('parseControlPointResponse reproduces SDK and Polar document vectors', async (t) => {
  for (const v of cp.responses) {
    await t.test(v.name, () => {
      const r = parseControlPointResponse(bytes(v.hex));
      for (const [k, want] of Object.entries(v.expect)) {
        if (k === 'parameters') assert.equal(toHex(r.parameters), want);
        else if (k === 'settings') assert.deepEqual(r.settings, settingsWanted(want));
        else if (k === 'settingsError') assert.match(r.settingsError, escape(want));
        else assert.deepEqual(r[k], want, k);
      }
    });
  }
});

// Catches wrong field sizes (4-byte RANGE_MILLIUNIT), lost multi-value lists, and undetected truncation.
test('parseSettings reproduces the PmdSetting vectors', async (t) => {
  for (const v of cp.settings) {
    await t.test(v.name, () => {
      if (v.throws) assert.throws(() => parseSettings(bytes(v.hex)), { message: escape(v.throws) });
      else assert.deepEqual(parseSettings(bytes(v.hex)), v.expect);
    });
  }
});

// Catches settings serialised with wrong sizes, or FACTOR leaking into the start command.
test('buildStart parses back to the selected settings (SDK serialization test)', () => {
  for (const v of cp.serialization) assert.deepEqual(parseSettings(buildStart(MT.ACC, v.selected).subarray(2)), v.expect);
});

// Catches wrong op codes, setting order or byte order in the commands the dashboard writes, and feature bits
// mapped to the wrong measurement types.
test('commands and feature bits match Polar\'s Verity Sense examples', () => {
  const fns = { buildStart, buildGetSettings, buildStop };
  for (const v of cp.commands) assert.equal(toHex(fns[v.call[0]](...v.call.slice(1))), v.hex, v.name);
  for (const v of cp.features) assert.deepEqual(parseFeatures(bytes(v.hex)), v.expect, v.name);
});

// ----------------------------------------------------------------------------------------------------------------
// Encoder (simulator only). Randomised round trips exist only because they catch encoder bugs (bit packing, block
// widths, reference bytes, headers, factor inversion) that would make the simulator show data a device never sends.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260925);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
function walk(n, channels, lo, hi, maxStep) {
  const out = [];
  for (let c = 0; c < channels; c++) out.push(int(lo, hi));
  for (let i = 1; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const step = rand() < 0.05 ? int(-(hi - lo), hi - lo) : int(-maxStep, maxStep); // occasional jumps force wide blocks
      out.push(Math.min(hi, Math.max(lo, out[(i - 1) * channels + c] + step)));
    }
  }
  return out;
}

// Round trip on random data: catches encoder bit-packing and block bugs (see note above).
test('encoder round trip: delta codec', () => {
  for (let k = 0; k < 300; k++) {
    const channels = [1, 3, 4, 17, 25][k % 5];
    const refBits = [16, 24, 32][k % 3];
    const signed = refBits < 32 || k % 2 === 0;
    const n = int(1, 600);
    const lim = 2 ** (refBits - 1);
    const s = Int32Array.from(walk(n, channels, -lim, lim - 1, int(0, 2 ** int(0, refBits - 2))));
    const payload = encodeDeltaFrames(s, channels, refBits);
    for (let off = channels * Math.ceil(refBits / 8); off < payload.length;) {
      const [w, cnt] = [payload[off], payload[off + 1]];
      assert.ok(w >= 2 && w <= 32 && cnt >= 1 && cnt <= 255, `block width ${w} count ${cnt}`);
      off += 2 + Math.ceil((w * cnt * channels) / 8);
    }
    const back = decodeDeltaFrames(payload, channels, refBits, signed);
    assert.equal(back.count, n);
    assert.deepEqual(back.samples, s);
  }
});

// Round trip on random data: catches encoder header, layout and factor-inversion bugs (see note above).
test('encoder round trip: frames', () => {
  const cases = [
    // [measType, frameType, compressed, factor, value generator for one sample, tolerance]
    [MT.PPG, 0, true, 1, () => ints(4, 21), 0], // 22-bit values, as Verity Sense reports
    [MT.PPG, 7, true, 1, () => [...ints(16, 23), int(0, 0xffffff)], 0],
    [MT.PPG, 8, true, 1, () => [...ints(24, 23), int(0, 0xffffff)], 0],
    [MT.PPG, 10, true, 1, () => [...ints(20, 23), int(-(2 ** 23), 2 ** 23 - 1)], 0],
    [MT.PPG, 13, true, 1, () => [...ints(2, 23), int(0, 0xffffff)], 0],
    [MT.PPG, 0, false, 1, () => ints(4, 23), 0],
    [MT.ACC, 0, true, 2.44e-4, () => ints(3, 0, 7990), 0], // Verity Sense: integer mG (16 bits x 0.244 mG), factor from its start response
    [MT.ACC, 1, true, 1, () => ints(3, 15), 0],
    [MT.ACC, 0, false, 1, () => ints(3, 7), 0],
    [MT.ACC, 1, false, 1, () => ints(3, 15), 0],
    [MT.ACC, 2, false, 1, () => ints(3, 23), 0],
    [MT.GYRO, 0, true, 1, () => ints(3, 15), 0],
    [MT.GYRO, 0, true, 0.061, () => [0, 0, 0].map(() => (rand() - 0.5) * 3900), 0.061 / 2 + 1e-4], // arbitrary deg/s: nearest count
    [MT.GYRO, 1, true, 1, () => [0, 0, 0].map(() => Math.fround((rand() - 0.5) * 4000)), 0],
    [MT.MAG, 0, true, 1, () => ints(3, 15), 0],
    [MT.MAG, 1, true, 1, () => [...ints(3, 15).map((v) => v / 1000), int(-1, 3)], 0],
  ];
  function ints(n, bits, max = 2 ** bits - 1) {
    return Array.from({ length: n }, () => int(-max - 1, max));
  }
  let ts = 700_000_000_000_000_000n;
  for (const [measType, frameType, compressed, factor, gen, tol] of cases) {
    for (let k = 0; k < 20; k++) {
      const n = int(1, 40);
      const values = Array.from({ length: n }, gen).flat();
      ts += 1_000_000_000n;
      const bytesOut = encodeFrame({ measType, timestampNs: ts, frameType, compressed, factor, values });
      const r = decodeFrame(bytesOut, { factor, sampleRateHz: 52, prevTimestampNs: 0n });
      const label = `${measType}/${frameType}/${compressed}`;
      assert.deepEqual([r.measType, r.frameType, r.compressed, r.count, r.timestampNs], [measType, frameType, compressed, n, ts], label);
      assert.equal(r.sampleTimestampsNs[n - 1], ts, label);
      values.forEach((v, i) => {
        const want = r.values instanceof Float32Array && tol === 0 ? Math.fround(v) : v;
        assert.ok(Math.abs(r.values[i] - want) <= tol, `${label} value ${i}: sent ${v}, decoded ${r.values[i]}`);
      });
    }
  }
});

// Catches simulator control point encoders that disagree with the Verity Sense bytes in Polar's examples.
test('simulator control point encoders reproduce device bytes', () => {
  const vsSettings = cp.responses.find((v) => v.name === 'Verity Sense ACC settings');
  assert.equal(toHex(buildSettingsResponse(MT.ACC, { sampleRate: [52], resolution: [16], range: [8], channels: [3] })), vsSettings.hex);
  const vsStart = cp.responses.find((v) => v.name === 'Verity Sense ACC start response with FACTOR');
  assert.equal(toHex(buildControlPointResponse({ opCode: OpCode.START, measType: MT.ACC, parameters: encodeSettings({ factor: [2.44e-4] }) })), vsStart.hex);
  assert.equal(toHex(encodeFeatures([MT.PPG, MT.ACC, MT.PPI, MT.GYRO, MT.MAG])), cp.features[0].hex);
});

// Round trip: catches PPI encoder byte-order and flag bugs (see note above). The SDK vector itself sets reserved
// flag bits (0xFF), which an encoder cannot reproduce, so its samples are round-tripped instead.
test('encoder round trip: PPI', () => {
  const ppi = frames.frames.find((x) => x.name === 'PPI raw type 0').expect.ppi;
  const r = decodeFrame(encodePpiFrame({ timestampNs: 5_000_000_000n, samples: ppi }));
  assert.deepEqual(r.ppi, ppi);
  assert.equal(r.sampleTimestampsNs[r.count - 1], 5_000_000_000n);
});

// Round trip on random data: catches HR encoder flag and RR unit bugs (see note above).
test('encoder round trip: heart rate measurement', () => {
  for (let k = 0; k < 200; k++) {
    const m = {
      hr: int(0, 300),
      sensorContactSupported: rand() < 0.5,
      sensorContact: rand() < 0.5,
      energyKj: rand() < 0.3 ? int(0, 65535) : null,
      rrMs: Array.from({ length: int(0, 4) }, () => int(250, 2500)),
    };
    const r = parseHeartRateMeasurement(new DataView(encodeHeartRateMeasurement(m).buffer));
    assert.deepEqual(
      [r.hr, r.sensorContactSupported, r.sensorContact, r.energyKj, r.rrsMs],
      [m.hr, m.sensorContactSupported, m.sensorContactSupported && m.sensorContact, m.energyKj, m.rrMs],
    );
  }
});
