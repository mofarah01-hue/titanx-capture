// A fake SensWear board (nRF54L15 main board with the PPG and temperature boards) behind a fake Web
// Bluetooth GATT API, for senswear.html?sim=N. SensWearLink (core/senswear/link.js) cannot tell it from
// the real board, so sim mode runs the real connect steps, decoders and recorder. Payloads follow
// SensWear's SDK (core/senswear/protocol.js): one sample per notification.
//
// What is a guess until the real board is measured, and marked so on the compare page:
//   - PPG at 200 samples per second per colour (the SDK README's figure), IMU at 100 Hz
//   - PPG time stamps on a ms clock and IMU time stamps on a µs clock that run from the same start
//   - gyro scale (the SDK declares none; the fake uses 16.4 counts per deg/s)
// Deliberate misbehaviour, as in the Polar fake: packets lost per models.lossFor, link dropouts per
// models.dropoutsFor.

import { UUID, encodeLed, ACC_LSB_PER_G, Q14, SHIELD, FEATURE, PPG_ADC_MAX } from '../senswear/protocol.js';
import { createWearer, dropoutsFor, lossFor } from './models.js';
import { MAX30101_POR, regFile } from './fake-max30101.js';

export const SIM_SW_IDS = ['5E1A0C93', '5E1A7B20', '5E1AF4D1'];
const SIM_START = performance.now();
const simNow = () => (performance.now() - SIM_START) / 1000;
const MODEL_OFFSET_S = 880;
const domErr = (name, msg) => Object.assign(new Error(msg), { name });
const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const GYRO_LSB_PER_DPS = 16.4;

class Char extends EventTarget {
  constructor(uuid, props, h = {}) { super(); this.uuid = uuid; this.properties = { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...props }; this.h = h; this.notifying = false; this.value = null; }
  async readValue() { if (!this.h.read) throw domErr('NotSupportedError', 'GATT operation not permitted.'); this.value = dv(await this.h.read()); return this.value; }
  async writeValueWithResponse(b) { if (!this.h.write) throw domErr('NotSupportedError', 'GATT operation not permitted.'); await this.h.write(new Uint8Array(b)); }
  async writeValue(b) { return this.writeValueWithResponse(b); }
  async startNotifications() { this.notifying = true; return this; }
  async stopNotifications() { this.notifying = false; return this; }
  push(b) { if (!this.notifying) return; this.value = dv(b); this.dispatchEvent(new Event('characteristicvaluechanged')); }
}
class Service {
  constructor(uuid, chars) { this.uuid = uuid; this.chars = chars; }
  async getCharacteristic(u) { const c = this.chars.find((x) => x.uuid === u); if (!c) throw domErr('NotFoundError', `No Characteristics matching UUID ${u} found in Service.`); return c; }
  async getCharacteristics() { return [...this.chars]; }
}

const u8 = (...a) => Uint8Array.from(a);
function le(n, bytes) { const b = new Uint8Array(bytes); const d = dv(b); if (bytes === 2) d.setUint16(0, n, true); else d.setUint32(0, n, true); return b; }

class FakeSensWear extends EventTarget {
  constructor(index) {
    super();
    this.index = index;
    this.id = SIM_SW_IDS[index % SIM_SW_IDS.length];
    this.name = 'Sens Wear (OOB)';
    this.wearer = createWearer({ seed: 21 + index, rest: 58 + index, max: 194, k: 0.95 });
    this.loss = lossFor(index + 1);
    this.dropouts = dropoutsFor(index + 1).map(([a, b]) => [a + 20, b + 20]);
    this.clock0Ms = Date.UTC(2026, 0, 1);              // like the stock firmware: the clock restarts at 2026-01-01 on every boot
    this.regs = regFile(MAX30101_POR);                  // the PPG chip, also reachable through the fake shell
    this.cfg = { ppg: true, ppgIrq: false, imu: false, drainMs: 100, tempS: 0, led: [0, 0, 0] }; // stock firmware: interval reads 0 but runs every minute
    const self = this;
    this.gatt = { device: this, connected: false, async connect() { return self.#connect(); }, disconnect() { self.#down(); }, async getPrimaryService(u) { return self.#service(u); } };
    const bool = (k) => ({ read: async () => u8(this.cfg[k] ? 1 : 0), write: async (b) => { if (b.length !== 1 || b[0] > 1) throw domErr('NotSupportedError', 'GATT write rejected'); this.cfg[k] = b[0] === 1; } });
    const c = this.c = {
      fw: new Char(UUID.FIRMWARE_REVISION, { read: true }, { read: async () => new TextEncoder().encode('0.1.0+sim') }),
      caps: new Char(UUID.CAPS, { read: true }, { read: async () => { const b = new Uint8Array(9); b[0] = 1; dv(b).setUint32(1, SHIELD.ppg | SHIELD.temperature, true); dv(b).setUint32(5, FEATURE.imu | FEATURE.led | FEATURE.ppg | FEATURE.temperature | FEATURE.battery | FEATURE.time, true); return b; } }),
      level: new Char(UUID.BATTERY_LEVEL, { read: true, notify: true }, { read: async () => u8(this.wearer.battery(simNow(), 92)) }),
      status: new Char(UUID.BATTERY_STATUS, { read: true, notify: true }, { read: async () => this.#status() }),
      time: new Char(UUID.CURRENT_TIME, { read: true, write: true }, { read: async () => timeBytes(new Date(this.#nowMs())), write: async (b) => { this.clock0Ms += Date.UTC(dv(b).getUint16(0, true), b[2] - 1, b[3], b[4], b[5], b[6], (b[8] * 1000) / 256) - this.#nowMs(); } }),
      temp: new Char(UUID.TEMP_MEASUREMENT, { indicate: true }),
      tempInterval: new Char(UUID.TEMP_INTERVAL, { read: true, write: true }, { read: async () => le(this.cfg.tempS, 2), write: async (b) => { this.cfg.tempS = dv(b).getUint16(0, true); } }),
      led: new Char(UUID.LED_COLOR, { read: true, write: true }, { read: async () => encodeLed(...this.cfg.led), write: async (b) => { this.cfg.led = [b[2], b[1], b[0]]; } }),
      quat: new Char(UUID.IMU_QUAT, { read: true, notify: true }), acc: new Char(UUID.IMU_ACC, { read: true, notify: true }),
      gyro: new Char(UUID.IMU_GYRO, { read: true, notify: true }), gesture: new Char(UUID.IMU_GESTURE, { read: true, notify: true }),
      activity: new Char(UUID.IMU_ACTIVITY, { read: true, notify: true }),
      imuEnable: new Char(UUID.IMU_ENABLE, { read: true, write: true }, bool('imu')),
      drain: new Char(UUID.IMU_DRAIN_MS, { read: true, write: true }, { read: async () => le(this.cfg.drainMs, 4), write: async (b) => { this.cfg.drainMs = dv(b).getUint32(0, true); } }),
      red: new Char(UUID.PPG_RED, { read: true, notify: true }), ir: new Char(UUID.PPG_IR, { read: true, notify: true }),
      green: new Char(UUID.PPG_GREEN, { read: true, notify: true }),
      ppgEnable: new Char(UUID.PPG_ENABLE, { read: true, write: true }, bool('ppg')),
      ppgIrq: new Char(UUID.PPG_IRQ_PER_SAMPLE, { read: true, write: true }, { read: bool('ppgIrq').read, write: async (b) => { if (this.cfg.ppg) throw domErr('NotSupportedError', 'GATT write rejected: stop PPG sampling first'); await bool('ppgIrq').write(b); } }),
    };
    this.services = [
      new Service(UUID.DEVICE_INFO, [c.fw]), new Service(UUID.CAPS_SERVICE, [c.caps]), new Service(UUID.BATTERY, [c.level, c.status]),
      new Service(UUID.TIME, [c.time]), new Service(UUID.THERMO, [c.temp, c.tempInterval]), new Service(UUID.LED, [c.led]),
      new Service(UUID.IMU, [c.quat, c.acc, c.gyro, c.gesture, c.activity]), new Service(UUID.IMU_CONFIG, [c.imuEnable, c.drain]),
      new Service(UUID.PPG, [c.red, c.ir, c.green]), new Service(UUID.PPG_CONFIG, [c.ppgEnable, c.ppgIrq]),
    ];
  }

  #nowMs() { return this.clock0Ms + (performance.now() - SIM_START); }
  #status() { const ps = 1 | (1 << 1) | (1 << 5) | (1 << 7); return u8(2, ps & 255, ps >> 8, this.wearer.battery(simNow(), 92)); }
  #service(u) {
    if (!this.gatt.connected) throw domErr('NetworkError', 'GATT Server is disconnected. Cannot retrieve services.');
    const s = this.services.find((x) => x.uuid === u);
    if (!s) throw domErr('NotFoundError', `No Services matching UUID ${u} found in Device.`);
    return s;
  }
  #inDropout(t = simNow()) { return this.dropouts.some(([a, b]) => t >= a && t < b); }
  async #connect() {
    await delay(500);
    if (this.#inDropout()) { await delay(1500); throw domErr('NetworkError', 'Connection attempt failed.'); }
    if (!this.gatt.connected) {
      this.gatt.connected = true;
      for (const ch of Object.values(this.c)) ch.notifying = false;
      this.k = { ppg: null, imu: null, temp: simNow() + 3 };
      clearInterval(this.timer); this.timer = setInterval(() => this.#tick(), 40);
    }
    return this.gatt;
  }
  #down() { if (!this.gatt.connected) return; this.gatt.connected = false; clearInterval(this.timer); this.dispatchEvent(new Event('gattserverdisconnected')); }

  #tick() {
    const now = simNow();
    if (this.#inDropout(now)) { this.#down(); return; }
    const w = this.wearer, mt = (t) => t + MODEL_OFFSET_S, ms = (t) => BigInt(Math.round(this.clock0Ms + t * 1000));
    const regs = this.regs;
    if (this.cfg.ppg && !(regs.get(0x09) & 0x80)) {
      const fs = 200;
      this.k.ppg ??= { t0: now, n: 0 };
      const p = this.k.ppg;
      const ledMa = (r) => regs.get(r) * 0.2;   // the fake's signal follows the LED current registers (stock: 1.6, 1.6, 0.6 mA)
      for (; p.t0 + p.n / fs <= now; p.n++) {
        if (Math.random() < this.loss) continue;
        const t = p.t0 + p.n / fs, T = mt(t);
        // MAX30101 counts: an 18 bit ADC, so the Polar model's counts are scaled down and clipped.
        const counts = (ch, ma, ref, gain) => Math.max(0, Math.min(PPG_ADC_MAX, Math.round((w.ppg(T, ch, p.n) / 2.4) * gain * (ma / ref))));
        this.c.green.push(ppg(ms(t), counts(0, ledMa(0x0e), 0.6, 1)));
        this.c.red.push(ppg(ms(t), counts(1, ledMa(0x0d), 1.6, 0.55)));   // swapped like the stock driver: LED2_PA drives what it calls red
        this.c.ir.push(ppg(ms(t), counts(2, ledMa(0x0c), 1.6, 0.8)));
      }
    } else this.k.ppg = null;
    if (this.cfg.imu) {
      const fs = 100;
      this.k.imu ??= { t0: now, n: 0 };
      const q = this.k.imu;
      for (; q.t0 + q.n / fs <= now; q.n++) {
        if (Math.random() < this.loss) continue;
        const t = q.t0 + q.n / fs, T = mt(t), us = ms(t) * 1000n;
        const a = [0, 1, 2].map((ax) => Math.round((w.acc(T, ax, q.n) / 1000) * ACC_LSB_PER_G));
        const g = [0, 1, 2].map((ax) => Math.round(w.gyro(T, ax, q.n) * GYRO_LSB_PER_DPS));
        this.c.acc.push(vec(us, a)); this.c.gyro.push(vec(us, g));
        const th = 0.3 * Math.sin(T / 5);
        this.c.quat.push(quat(us, [0, Math.sin(th / 2), 0, Math.cos(th / 2)]));
      }
    } else this.k.imu = null;
    if (now >= this.k.temp) { this.k.temp = now + (this.cfg.tempS || 60); this.c.temp.push(temp(33.4 + 0.6 * Math.sin(now / 300))); }
  }
}

function ppg(tMs, value) { const b = new Uint8Array(12); const d = dv(b); d.setBigUint64(0, tMs, true); d.setUint32(8, value, true); return b; }
function vec(tUs, [x, y, z]) { const b = new Uint8Array(14); const d = dv(b); d.setBigInt64(0, tUs, true); d.setInt16(8, x, true); d.setInt16(10, y, true); d.setInt16(12, z, true); return b; }
function quat(tUs, [x, y, z, w]) { const b = new Uint8Array(18); const d = dv(b); d.setBigInt64(0, tUs, true); [x, y, z, w].forEach((v, i) => d.setInt16(8 + i * 2, Math.round(v * Q14), true)); d.setUint16(16, Math.round(0.05 * Q14), true); return b; }
function temp(c) { const b = new Uint8Array(5); const m = Math.round(c * 100); dv(b).setUint32(1, ((0xfe << 24) | (m & 0xffffff)) >>> 0, true); return b; }
function timeBytes(t) { const b = new Uint8Array(10); const d = dv(b); d.setUint16(0, t.getUTCFullYear(), true); b.set([t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCDay() || 7, Math.floor((t.getUTCMilliseconds() * 256) / 1000), 0], 2); return b; }

/** Stand in for navigator.bluetooth on the SensWear page. */
export class SimSensWearRadio {
  constructor(count) { this.devices = Array.from({ length: Math.max(1, Math.min(3, count)) }, (_, i) => new FakeSensWear(i)); this.pending = null; this.onChooser = null; }
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
