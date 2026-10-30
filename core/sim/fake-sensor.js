// A fake Polar Verity Sense behind a fake Web Bluetooth GATT API, for ?sim=N. SensorLink
// (core/ble/device.js) cannot tell it from the real thing, so sim mode exercises the real connect
// steps, the real decoder and the real recorder. Frames are built with core/pmd/encode.js.
//
// Deliberate misbehaviour, because the real sensor does it too:
//   - the raw data service refuses writes for about 2.6 s after connect (tests the retry)
//   - some packets are lost (tests gap logging), per sensor from models.lossFor
//   - the radio link drops for a while, per sensor from models.dropoutsFor (tests reconnect)
//   - PPI starts about 25 s after it is switched on, and HR then only changes every 5 s
//   - a PPI start in SDK mode is refused with "invalid state"

import { PMD_SERVICE_UUID, PMD_CONTROL_POINT_UUID, PMD_DATA_UUID, MeasurementType as MT, OpCode, VERITY_SENSE } from '../pmd/constants.js';
import { buildControlPointResponse, buildSettingsResponse, encodeSettings, encodeFeatures, encodeFrame, encodePpiFrame, encodeHeartRateMeasurement } from '../pmd/encode.js';
import { createWearer, dropoutsFor, lossFor } from './models.js';

export const SIM_IDS = ['C8A1B2E4', 'D2403C19', 'D2407A55', 'C8A1F07D', 'B91E0C33', 'B91E6D02', 'A07C2F18', 'E3B5A901', 'F1C7D244', 'A95E3B70'];
const WEARERS = [
  { seed: 1, rest: 56, max: 190, k: 1.02 }, { seed: 3, rest: 58, max: 197, k: 0.9 }, { seed: 4, rest: 61, max: 192, k: 1 },
  null /* same head as sensor 2, unless every sensor is its own person */, { seed: 5, rest: 57, max: 198, k: 0.95 }, { seed: 6, rest: 60, max: 203, k: 0.97 },
  { seed: 7, rest: 64, max: 190, k: 0.3 }, { seed: 8, rest: 59, max: 196, k: 0.8 }, { seed: 9, rest: 55, max: 200, k: 1.08 }, { seed: 10, rest: 62, max: 188, k: 0.7 },
];
const OWN_HEAD_3 = { seed: 11, rest: 60, max: 194, k: 0.86 };
const NS_2000 = BigInt(Date.UTC(2000, 0, 1)) * 1000000n;
const MODEL_OFFSET_S = 880; // start the practice script just before the first live bout
const SIM_START = performance.now();
const simNow = () => (performance.now() - SIM_START) / 1000; // seconds since the page loaded

const full = (u) => (typeof u === 'number' ? `0000${u.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb` : String(u).toLowerCase());
const domErr = (name, msg) => Object.assign(new Error(msg), { name });
const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Factors a start response carries. ACC is Polar's own Verity Sense example (online_measurement.pdf p.14).
const FACTOR = { [MT.ACC]: 2.44140625e-4, [MT.GYRO]: 2000 / 32768, [MT.MAG]: 50 / 32768 };
const PER_FRAME = { [MT.PPG]: 28, [MT.ACC]: 36, [MT.GYRO]: 36, [MT.MAG]: 10 };
function offered(type, sdk) {
  const v = VERITY_SENSE[{ [MT.PPG]: 'PPG', [MT.ACC]: 'ACC', [MT.GYRO]: 'GYRO', [MT.MAG]: 'MAG' }[type]];
  const s = { ...(sdk ? v.sdkMode : v.normal) };
  s.channels = [type === MT.PPG ? 4 : 3];
  return s;
}

class FakeChar extends EventTarget {
  constructor(uuid, properties, handlers = {}) {
    super();
    this.uuid = full(uuid);
    this.properties = { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...properties };
    this.h = handlers;
    this.notifying = false;
    this.value = null;
  }
  async readValue() { if (!this.h.read) throw domErr('NotSupportedError', 'GATT operation not permitted.'); this.value = dv(await this.h.read()); return this.value; }
  async writeValueWithResponse(bytes) { if (!this.h.write) throw domErr('NotSupportedError', 'GATT operation not permitted.'); await this.h.write(new Uint8Array(bytes)); }
  async startNotifications() { this.notifying = true; return this; }
  async stopNotifications() { this.notifying = false; return this; }
  push(bytes) { if (!this.notifying) return; this.value = dv(bytes); this.dispatchEvent(new Event('characteristicvaluechanged')); }
}
class FakeService {
  constructor(uuid, chars) { this.uuid = full(uuid); this.chars = chars; }
  async getCharacteristic(u) { const c = this.chars.find((x) => x.uuid === full(u)); if (!c) throw domErr('NotFoundError', `No Characteristics matching UUID ${full(u)} found in Service.`); return c; }
  async getCharacteristics() { return [...this.chars]; }
}

class FakeDevice extends EventTarget {
  constructor(index, distinct = false) {
    super();
    this.index = index;
    this.id = SIM_IDS[index % SIM_IDS.length];
    this.name = `Polar Sense ${this.id}`;
    this.wearer = createWearer(WEARERS[index % WEARERS.length] || (distinct ? OWN_HEAD_3 : WEARERS[2]));
    this.loss = lossFor(index);
    this.dropouts = dropoutsFor(index).map(([a, b]) => [a + 20, b + 20]); // seconds after page load
    this.drift = [12, -8, 20, 5, -15, 3, 9][index % 7] * 1e-6;
    this.clockBase = BigInt(Date.now()) * 1000000n - NS_2000;
    this.batteryStart = [85, 74, 61, 77, 58, 38, 22][index % 7];
    const self = this;
    this.gatt = {
      device: this,
      connected: false,
      async connect() { return self.#connect(); },
      disconnect() { self.#linkDown(false); },
      async getPrimaryService(u) { return self.#service(u); },
    };
    const hr = new FakeChar(0x2a37, { notify: true });
    const batt = new FakeChar(0x2a19, { read: true }, { read: async () => Uint8Array.of(this.wearer.battery(simNow(), this.batteryStart)) });
    const cp = new FakeChar(PMD_CONTROL_POINT_UUID, { read: true, write: true, indicate: true }, {
      read: async () => encodeFeatures([MT.PPG, MT.ACC, MT.PPI, MT.GYRO, MT.MAG, MT.SDK_MODE]),
      write: (b) => this.#command(b),
    });
    const data = new FakeChar(PMD_DATA_UUID, { notify: true });
    this.c = { hr, batt, cp, data };
    this.services = [new FakeService(0x180d, [hr]), new FakeService(0x180f, [batt]), new FakeService(PMD_SERVICE_UUID, [cp, data])];
    this.#reset();
  }

  #reset() { this.streams = new Map(); this.sdk = false; this.ppiOnAt = null; this.lastPpiT = null; this.nextHrT = null; }
  /** Another phone or app starts its own raw stream on this sensor: ours stop while the link stays up.
   *  notice: also send Polar's stop notice (0x01 + types) on the control point. */
  takeover(notice = false) {
    const types = [...this.streams.keys()];
    this.streams.clear(); this.ppiOnAt = null; this.sdk = false;
    if (notice) this.c.cp.push(Uint8Array.of(0x01, ...types));
  }
  #service(u) {
    if (!this.gatt.connected) throw domErr('NetworkError', 'GATT Server is disconnected. Cannot retrieve services.');
    const s = this.services.find((x) => x.uuid === full(u));
    if (!s) throw domErr('NotFoundError', `No Services matching UUID ${full(u)} found in Device.`);
    return s;
  }
  #inDropout(t = simNow()) { return this.dropouts.some(([a, b]) => t >= a && t < b); }

  async #connect() {
    await delay(400 + 300 * (this.index % 3));
    if (this.#inDropout()) { await delay(1500); throw domErr('NetworkError', 'Connection attempt failed.'); }
    if (!this.gatt.connected) {
      this.gatt.connected = true;
      this.connectedAt = simNow();
      this.#reset();
      for (const ch of Object.values(this.c)) ch.notifying = false;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.#tick(), 40);
    }
    return this.gatt;
  }

  #linkDown(unexpected) {
    if (!this.gatt.connected) return;
    this.gatt.connected = false;
    clearInterval(this.timer);
    this.#reset();
    this.dispatchEvent(new Event('gattserverdisconnected'));
    void unexpected;
  }

  #devNs(t) { return this.clockBase + BigInt(Math.round(t * 1e9 * (1 + this.drift))); }

  async #command(b) {
    if (!this.gatt.connected) throw domErr('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.');
    if (simNow() - this.connectedAt < 2.6) throw domErr('NotSupportedError', 'GATT operation failed for unknown reason.');
    const [op, type] = b;
    const reply = (status, parameters) => setTimeout(() => this.c.cp.push(buildControlPointResponse({ opCode: op, measType: type, status, parameters })), 30);
    if (type === MT.SDK_MODE) {
      if (op === OpCode.START) { if (this.sdk) return reply(6); if (this.streams.size) return reply(12); this.sdk = true; return reply(0); }
      if (op === OpCode.STOP) { if (!this.sdk) return reply(6); this.sdk = false; this.streams.clear(); return reply(0); }
    }
    if (op === OpCode.GET_SETTINGS) {
      if (type === MT.PPI) return reply(0);
      return setTimeout(() => this.c.cp.push(buildSettingsResponse(type, offered(type, this.sdk))), 30);
    }
    if (op === OpCode.START) {
      if (type === MT.PPI) {
        if (this.sdk) return reply(12);
        if (this.ppiOnAt != null) return reply(6);
        this.ppiOnAt = simNow(); this.lastPpiT = this.ppiOnAt + 20;
        return reply(0);
      }
      if (this.streams.has(type)) return reply(6);
      const req = parseStart(b);
      const allowed = offered(type, this.sdk);
      if (!allowed.sampleRate.includes(req.sampleRate)) return reply(8);
      const f = FACTOR[type];
      this.streams.set(type, { fs: req.sampleRate, k: 0, t0: simNow() + 0.05, factor: f ?? 1 });
      return reply(0, f ? encodeSettings({ factor: [f] }) : new Uint8Array(0));
    }
    if (op === OpCode.STOP) {
      if (type === MT.PPI) { if (this.ppiOnAt == null) return reply(6); this.ppiOnAt = null; return reply(0); }
      if (!this.streams.delete(type)) return reply(6);
      return reply(0);
    }
    return reply(1);
  }

  #tick() {
    const now = simNow();
    if (this.#inDropout(now)) { this.#linkDown(true); return; }
    const w = this.wearer, mt = (t) => t + MODEL_OFFSET_S;
    for (const [type, s] of this.streams) {
      const n = PER_FRAME[type];
      while (s.t0 + (s.k + n - 1) / s.fs <= now) {
        const values = [];
        for (let i = 0; i < n; i++) {
          const k = s.k + i, t = mt(s.t0 + k / s.fs);
          if (type === MT.PPG) values.push(w.ppg(t, 0, k), w.ppg(t, 1, k), w.ppg(t, 2, k), w.ppg(t, 3, k));
          else if (type === MT.ACC) values.push(w.acc(t, 0, k), w.acc(t, 1, k), w.acc(t, 2, k));
          else if (type === MT.GYRO) values.push(w.gyro(t, 0, k), w.gyro(t, 1, k), w.gyro(t, 2, k));
          else values.push(w.mag(t, 0, k), w.mag(t, 1, k), w.mag(t, 2, k));
        }
        const lastT = s.t0 + (s.k + n - 1) / s.fs;
        s.k += n;
        if (Math.random() < this.loss) continue; // lost over the air: the sensor's clock moves on regardless
        this.c.data.push(encodeFrame({ measType: type, timestampNs: this.#devNs(lastT), frameType: 0, compressed: true, resolution: type === MT.PPG ? 22 : 16, factor: s.factor, values }));
      }
    }
    if (!this.sdk) {
      this.nextHrT ??= now + 1;
      if (now >= this.nextHrT) {
        this.nextHrT += 1;
        const ppi = this.ppiOnAt != null;
        const hr = Math.round(w.hrAt(mt(ppi ? Math.floor(now / 5) * 5 : now)));
        this.c.hr.push(encodeHeartRateMeasurement({ hr, sensorContact: true, sensorContactSupported: true }));
      }
      if (this.ppiOnAt != null && now - this.ppiOnAt >= 25 && now - this.lastPpiT >= 5) {
        const beats = w.beats(mt(this.lastPpiT), mt(now));
        this.lastPpiT = now;
        const samples = [];
        for (let i = 1; i < beats.length; i++) {
          const pp = Math.round((beats[i] - beats[i - 1]) * 1000 + 6 * Math.sin(beats[i] * 13.7));
          samples.push({ hr: Math.min(255, Math.round(60000 / pp)), ppMs: pp, ppErrorMs: 6 + (i % 5), blocker: 0, skinContact: 1, skinContactSupported: 1 });
        }
        if (samples.length) this.c.data.push(encodePpiFrame({ timestampNs: this.#devNs(beats[beats.length - 1] - MODEL_OFFSET_S), samples }));
      }
    }
  }
}

function parseStart(b) {
  const out = {};
  for (let i = 2; i + 2 <= b.length;) {
    const type = b[i], n = b[i + 1], size = { 0: 2, 1: 2, 2: 2, 3: 4, 4: 1 }[type];
    if (size === undefined) break;
    let v = 0; for (let j = 0; j < size; j++) v |= b[i + 2 + j] << (8 * j);
    out[{ 0: 'sampleRate', 1: 'resolution', 2: 'range', 3: 'rangeMilliunit', 4: 'channels' }[type]] = v;
    i += 2 + n * size;
  }
  return out;
}

/** Stand in for navigator.bluetooth. The app shows its own chooser for sim sensors. */
export class SimRadio {
  /** distinct: every sensor on its own person (the 8 to 10 sensor demo); otherwise sensors 2 and 3 share a head. */
  constructor(count, { distinct = false } = {}) { this.devices = Array.from({ length: count }, (_, i) => new FakeDevice(i, distinct)); this.pending = null; this.onChooser = null; }
  async getAvailability() { return true; }
  addEventListener() {}
  requestDevice() {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (this.onChooser) this.onChooser(this.devices.filter((d) => !d.gatt.connected));
      else reject(domErr('NotFoundError', 'User cancelled the requestDevice() chooser.'));
    });
  }
  choose(id) { const d = this.devices.find((x) => x.id === id); this.pending?.resolve(d); this.pending = null; }
  cancel() { this.pending?.reject(domErr('NotFoundError', 'User cancelled the requestDevice() chooser.')); this.pending = null; }
}
