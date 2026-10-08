// Connect flow and controls for one SensWear board. Same shape as SensorLink (core/ble/device.js) so the
// app treats both alike: ordered steps with retries, resume from the failed step without the chooser,
// automatic reconnect, onPacket / onStream / onState callbacks. Steps the board's firmware did not
// compile in (read from its capabilities) are skipped and say so.
// The runner is a copy of SensorLink's; the two merge when the two GUIs are combined (DECISIONS D45).

import { UUID, SERVICES, NAME_PREFIXES, decodeCapabilities, decodeBatteryLevel, decodePowerStatus, decodeCurrentTime, encodeCurrentTime,
  decodeBool, encodeBool, decodeU16, decodeU32, encodeU32, encodeTempInterval, encodeLed, decodeLed, encodeHaptic } from './protocol.js';
import { LinkError } from '../ble/device.js';

/** Nominal rates from SensWear's SDK README; the measured rates are what count. */
export const NOMINAL_HZ = { ppg: 200, ppg_red: 200, ppg_ir: 200, acc: 100, gyro: 100, quat: 100 };

export const SW_STEPS = ['connected', 'settled', 'info', 'battery', 'clock', 'ppg', 'imu', 'temperature'];

export function chooseSensWear(bluetooth = navigator.bluetooth) {
  return bluetooth.requestDevice({ filters: NAME_PREFIXES.map((namePrefix) => ({ namePrefix })), optionalServices: [...SERVICES] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_MS = [0, 500, 1000, 2000, 4000];
const FATAL = new Set(['noPick', 'btOff', 'blocked', 'closed']);
const copy = (dv) => new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new LinkError('dropped', `${what} timed out after ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}
function classify(e, step) {
  if (e instanceof LinkError) return e;
  const m = String(e?.message || e);
  if (e?.name === 'NotFoundError' && /cancel/i.test(m)) return new LinkError('noPick', m);
  if (e?.name === 'NotFoundError' && /adapter|not available|powered/i.test(m)) return new LinkError('btOff', m);
  if (e?.name === 'SecurityError') return new LinkError('blocked', m);
  if (e?.name === 'NetworkError' || /disconnected|not connected/i.test(m)) return new LinkError('dropped', m);
  return new LinkError('refused', `${step}: ${e?.name ? e.name + ': ' : ''}${m}`);
}

// Notifications the worker decodes, by packet kind.
const STREAMS = {
  ppg: [['ppg', UUID.PPG_GREEN], ['ppg_red', UUID.PPG_RED], ['ppg_ir', UUID.PPG_IR]],
  imu: [['acc', UUID.IMU_ACC], ['gyro', UUID.IMU_GYRO], ['quat', UUID.IMU_QUAT], ['gesture', UUID.IMU_GESTURE], ['activity', UUID.IMU_ACTIVITY]],
};

export class SensWearLink {
  constructor(device, o = {}) {
    this.device = device;
    this.kind = 'senswear';
    this.mode = 'senswear';
    this.settleMs = o.settleMs ?? 600;
    this.imuOn = o.imu ?? true;                      // physical IMU streams are off after boot; we turn them on
    this.onPacket = o.onPacket || (() => {});
    this.onStream = o.onStream || (() => {});
    this.onState = o.onState || (() => {});
    this.state = 'idle'; this.steps = {}; this.log = []; this.error = null; this.failedAt = null;
    this.reconnectAttempt = 0; this.userClosed = false; this.streams = {}; this.chars = new Map();
    this.board = { firmware: null, caps: null, clock: null, power: null, battery: null, notes: [] };
    this.cfg = {};                                   // last values read from the board: ppg, ppgIrq, imu, drainMs, tempS, led
    this.autoClock = o.autoClock ?? true;           // set the board clock on connect when it is more than 2 s off
    device.addEventListener('gattserverdisconnected', () => this.#dropped());
    this.#resetSteps();
  }

  get name() { return this.device.name; }
  get batteryPct() { return this.board.battery; }

  run(from = null) {
    if (this.running) return this.running;
    this.userClosed = false;
    let i = from ? Math.max(0, SW_STEPS.indexOf(from)) : 0;
    if (!this.device.gatt.connected) i = 0;
    for (const n of SW_STEPS.slice(i)) this.steps[n] = { state: 'todo' };
    if (this.state !== 'reconnecting') this.state = 'connecting';
    this.error = null; this.failedAt = null; this.t0 = performance.now();
    this.#emit();
    this.running = (async () => {
      for (; i < SW_STEPS.length; i++) await this.#runStep(SW_STEPS[i]);
      this.state = 'streaming'; this.reconnectAttempt = 0;
      this.#log('ok', 'all streams running');
      this.#emit();
    })().finally(() => { this.running = null; });
    return this.running;
  }
  retry() { return this.run(this.failedAt); }
  async disconnect() {
    this.userClosed = true;
    try { this.device.gatt.disconnect(); } catch { /* already gone */ }
    this.state = 'disconnected'; this.#emit();
  }
  async setMode() { /* SensWear has one mode; rates and currents are set from the engineering view */ }

  // ---------- steps ----------
  async connected() { this.server = await withTimeout(this.device.gatt.connect(), 15000, 'Connecting'); this.chars.clear(); }
  async settled() { await sleep(this.settleMs); }

  async info() {
    try { this.board.firmware = new TextDecoder().decode(copy(await (await this.#char(UUID.DEVICE_INFO, UUID.FIRMWARE_REVISION)).readValue())); } catch (e) { this.#note(`firmware revision not readable: ${e.message}`); }
    try { this.board.caps = decodeCapabilities(copy(await (await this.#char(UUID.CAPS_SERVICE, UUID.CAPS)).readValue())); this.#log('note', `capabilities: shields ${this.board.caps.shields.join(',') || 'none'}; features ${this.board.caps.features.join(',')}`); } catch (e) { this.#note(`capabilities not readable: ${e.message}; trying every service`); }
  }

  async battery() {
    try {
      const lv = await this.#char(UUID.BATTERY, UUID.BATTERY_LEVEL);
      this.#battery(copy(await lv.readValue()));
      if (lv.properties.notify) { lv.addEventListener('characteristicvaluechanged', (e) => this.#battery(copy(e.target.value))); await lv.startNotifications().catch(() => {}); }
    } catch (e) { this.#note(`battery level not readable: ${e.message}`); }
    try {
      const st = await this.#char(UUID.BATTERY, UUID.BATTERY_STATUS);
      this.#power(copy(await st.readValue()));
      if (st.properties.notify || st.properties.indicate) { st.addEventListener('characteristicvaluechanged', (e) => this.#power(copy(e.target.value))); await st.startNotifications().catch(() => {}); }
    } catch (e) { this.#note(`power status not readable: ${e.message}`); }
  }

  async clock() {
    if (!this.#has('time')) return this.#note('no clock service in this firmware');
    const ch = await this.#char(UUID.TIME, UUID.CURRENT_TIME);
    const before = decodeCurrentTime(copy(await ch.readValue())).date;
    this.board.clock = { board: before.toISOString(), pcAtRead: new Date().toISOString(), offsetS: (before - Date.now()) / 1000 };
    this.#log('note', `board clock ${this.board.clock.offsetS.toFixed(1)} s from this PC`);
    // The stock firmware restarts its clock at 2026-01-01 on every boot, so every time stamp would be off.
    if (this.autoClock && Math.abs(this.board.clock.offsetS) > 2) {
      this.autoClock = false;
      this.#note(`board clock was ${this.board.clock.board}; set from this PC`);
      await ch.writeValueWithResponse(encodeCurrentTime(new Date(), 2));
      await this.clock();
    }
  }

  async ppg() {
    if (!this.#has('ppg')) return this.#note('no PPG board in this firmware build');
    await this.#subscribe(STREAMS.ppg);
    const en = await this.#char(UUID.PPG_CONFIG, UUID.PPG_ENABLE);
    this.cfg.ppg = decodeBool(copy(await en.readValue()), 'PPG enable');
    if (!this.cfg.ppg) { await en.writeValueWithResponse(encodeBool(true)); this.cfg.ppg = true; }
    try { this.cfg.ppgIrq = decodeBool(copy(await (await this.#char(UUID.PPG_CONFIG, UUID.PPG_IRQ_PER_SAMPLE)).readValue()), 'PPG IRQ'); } catch (e) { this.#note(`PPG IRQ mode not readable: ${e.message}`); }
    for (const [k] of STREAMS.ppg) this.#stream(k, { sampleRate: NOMINAL_HZ[k], unit: 'counts', settings: { nominal: true } });
  }

  async imu() {
    if (!this.#has('imu')) return this.#note('no IMU service in this firmware');
    await this.#subscribe(STREAMS.imu);
    const en = await this.#char(UUID.IMU_CONFIG, UUID.IMU_ENABLE);
    this.cfg.imu = decodeBool(copy(await en.readValue()), 'IMU enable');
    if (this.imuOn && !this.cfg.imu) { await en.writeValueWithResponse(encodeBool(true)); this.cfg.imu = true; }
    try { this.cfg.drainMs = decodeU32(copy(await (await this.#char(UUID.IMU_CONFIG, UUID.IMU_DRAIN_MS)).readValue()), 'IMU drain period'); } catch (e) { this.#note(`IMU drain period not readable: ${e.message}`); }
    for (const k of ['acc', 'gyro', 'quat']) this.#stream(k, { sampleRate: NOMINAL_HZ[k], settings: { nominal: true } });
  }

  async temperature() {
    if (!this.#has('temperature')) return this.#note('no temperature board in this firmware build');
    const m = await this.#char(UUID.THERMO, UUID.TEMP_MEASUREMENT);
    m.addEventListener('characteristicvaluechanged', (e) => this.onPacket('temp', copy(e.target.value), performance.now()));
    await m.startNotifications();
    try { this.cfg.tempS = decodeU16(copy(await (await this.#char(UUID.THERMO, UUID.TEMP_INTERVAL)).readValue()), 'temperature interval'); } catch (e) { this.#note(`temperature interval not readable: ${e.message}`); }
    try { this.cfg.led = decodeLed(copy(await (await this.#char(UUID.LED, UUID.LED_COLOR)).readValue())); } catch { /* LED colour is write only on some builds */ }
  }

  // ---------- controls for the engineering view; each returns the value read back where the board allows ----------
  async setPpg(on) { await this.#write(UUID.PPG_CONFIG, UUID.PPG_ENABLE, encodeBool(on)); this.cfg.ppg = on; this.#emit(); }
  /** The SDK says per sample IRQ mode may only change while PPG sampling is stopped; this stops and restarts it. */
  async setPpgIrq(on) {
    const was = this.cfg.ppg;
    if (was) await this.setPpg(false);
    await this.#write(UUID.PPG_CONFIG, UUID.PPG_IRQ_PER_SAMPLE, encodeBool(on)); this.cfg.ppgIrq = on;
    if (was) await this.setPpg(true);
    this.#emit();
  }
  async setImu(on) { await this.#write(UUID.IMU_CONFIG, UUID.IMU_ENABLE, encodeBool(on)); this.cfg.imu = on; this.#emit(); }
  async setDrainMs(ms) { await this.#write(UUID.IMU_CONFIG, UUID.IMU_DRAIN_MS, encodeU32(ms)); this.cfg.drainMs = ms; this.#emit(); }
  async setTempInterval(s) { await this.#write(UUID.THERMO, UUID.TEMP_INTERVAL, encodeTempInterval(s)); this.cfg.tempS = s; this.#emit(); }
  async setLed(r, g, b) { await this.#write(UUID.LED, UUID.LED_COLOR, encodeLed(r, g, b)); this.cfg.led = { r, g, b }; this.#emit(); }
  async haptic(frames) { await this.#write(UUID.HAPTIC, UUID.HAPTIC_PATTERN, encodeHaptic(frames)); }
  /** Sets the board's clock to this PC's UTC time, then reads it back. */
  async syncClock() {
    const ch = await this.#char(UUID.TIME, UUID.CURRENT_TIME);
    await ch.writeValueWithResponse(encodeCurrentTime(new Date(), 2));
    await this.clock();
    this.#emit();
    return this.board.clock;
  }

  // ---------- internals ----------
  #has(what) {
    const c = this.board.caps;
    if (!c) return true;                             // capabilities unreadable: try it and let the step say
    if (what === 'ppg' || what === 'temperature' || what === 'touch' || what === 'haptic') return c.shields.includes(what) || c.features.includes(what);
    return c.features.includes(what);
  }
  async #char(svc, ch) {
    const key = `${svc}/${ch}`;
    if (!this.chars.has(key)) this.chars.set(key, await (await this.server.getPrimaryService(svc)).getCharacteristic(ch));
    return this.chars.get(key);
  }
  async #write(svc, ch, bytes) { if (!this.device.gatt.connected) throw new LinkError('dropped', 'not connected'); await (await this.#char(svc, ch)).writeValueWithResponse(bytes); this.#log('tx', `${ch.slice(0, 8)} ${[...bytes].map((x) => x.toString(16).padStart(2, '0')).join('')}`); }
  async #subscribe(list) {
    for (const [kind, uuid] of list) {
      const svc = list === STREAMS.ppg ? UUID.PPG : UUID.IMU;
      const c = await this.#char(svc, uuid);
      if (c._swListener) c.removeEventListener('characteristicvaluechanged', c._swListener);
      c._swListener = (e) => this.onPacket(kind, copy(e.target.value), performance.now());
      c.addEventListener('characteristicvaluechanged', c._swListener);
      await c.startNotifications();
    }
  }
  #stream(key, cfg) { const c = { key, mode: 'senswear', ...cfg }; this.streams[key] = c; this.onStream(key, c); }
  #battery(b) { try { this.board.battery = decodeBatteryLevel(b); this.onPacket('battery', b.slice(), performance.now()); this.#emit(); } catch (e) { this.#log('error', e.message); } }
  #power(b) { try { this.board.power = decodePowerStatus(b); this.onPacket('power', b.slice(), performance.now()); this.#emit(); } catch (e) { this.#log('error', e.message); } }
  #note(msg) { this.board.notes.push(msg); this.#log('note', msg); }

  async #runStep(name) {
    this.steps[name] = { state: 'running' }; this.#emit();
    let last;
    for (let a = 0; a < BACKOFF_MS.length; a++) {
      if (BACKOFF_MS[a]) { this.#log('retry', `${name}: try ${a + 1} in ${BACKOFF_MS[a]} ms`); this.steps[name] = { state: 'running', attempts: a + 1 }; this.#emit(); await sleep(BACKOFF_MS[a]); }
      if (this.userClosed) throw new LinkError('closed', 'closed by user');
      try {
        await this[name]();
        this.steps[name] = { state: 'done', ms: Math.round(performance.now() - this.t0), attempts: a + 1 };
        this.#log('step', `${name} done after ${a + 1} ${a ? 'tries' : 'try'}`); this.#emit();
        return;
      } catch (e) {
        last = classify(e, name);
        this.#log('error', `${name}: ${last.code}: ${last.message}`);
        if (FATAL.has(last.code)) break;
        if (last.code === 'dropped' && !this.device.gatt.connected && name !== 'connected') break;
      }
    }
    this.steps[name] = { state: 'failed' };
    this.failedAt = !this.device.gatt.connected ? 'connected' : name;
    this.error = last;
    if (this.state !== 'reconnecting') this.state = 'failed';
    this.#emit();
    throw last;
  }
  #dropped() {
    this.#log('drop', 'Bluetooth link lost');
    this.streams = {}; this.chars.clear(); this.#resetSteps();
    if (this.userClosed) { this.state = 'disconnected'; this.#emit(); return; }
    this.state = 'reconnecting'; this.#emit();
    this.#reconnect();
  }
  async #reconnect() {
    while (!this.userClosed && this.state === 'reconnecting') {
      this.reconnectAttempt++; this.#emit();
      try { await this.run('connected'); return; } catch (e) { if (e.code === 'closed') return; this.state = 'reconnecting'; }
      await sleep(Math.min(10000, 1000 * 2 ** Math.min(this.reconnectAttempt, 4)));
    }
  }
  #resetSteps() { this.steps = Object.fromEntries(SW_STEPS.map((n) => [n, { state: 'todo' }])); }
  #log(kind, msg) { this.log.push({ t: Math.round(performance.now()), kind, msg }); if (this.log.length > 800) this.log.splice(0, 200); }
  #emit() {
    this.onState({
      state: this.state, mode: 'senswear', kind: 'senswear', battery: this.board.battery, power: this.board.power, reconnectAttempt: this.reconnectAttempt,
      failedAt: this.failedAt, error: this.error && { code: this.error.code, message: this.error.message },
      steps: SW_STEPS.map((n) => ({ name: n, ...this.steps[n] })), streams: { ...this.streams },
      board: { ...this.board, notes: [...this.board.notes] }, cfg: { ...this.cfg },
    });
  }
}
