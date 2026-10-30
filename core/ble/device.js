// Connect flow for one Polar Verity Sense. Main thread only, because Web Bluetooth lives there.
// Every step runs in order and is retried with backoff (right after connect the PMD service refuses
// writes for a while on recent firmware; that looks like a dead sensor and is not). A failed run
// resumes from the failed step on the same BluetoothDevice, so no chooser popup is needed. After an
// unexpected drop the link reconnects by itself. The simulator runs this exact code against a fake
// GATT server (core/sim/fake-sensor.js).

import { PMD_SERVICE_UUID, PMD_CONTROL_POINT_UUID, PMD_DATA_UUID, MeasurementType as MT, OpCode } from '../pmd/constants.js';
import { parseControlPointResponse, parseFeatures, parseSettings, buildGetSettings, buildStart, buildStop } from '../pmd/decode.js';
import { HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, BATTERY_SERVICE, BATTERY_LEVEL, parseBatteryLevel } from './gatt-parse.js';

// Every service must be listed here or Chrome refuses access to it for the whole session.
export const OPTIONAL_SERVICES = [HEART_RATE_SERVICE, BATTERY_SERVICE, PMD_SERVICE_UUID];
export const STREAM_TYPES = Object.freeze({ ppg: MT.PPG, acc: MT.ACC, gyro: MT.GYRO, mag: MT.MAG, ppi: MT.PPI });

export function stepsFor(mode) {
  return mode === 'max'
    ? ['connected', 'settled', 'battery', 'pmd', 'sdk', 'ppg', 'acc', 'gyro', 'mag']
    : ['connected', 'settled', 'battery', 'hr', 'pmd', 'ppg', 'acc', 'gyro', 'mag', 'ppi'];
}

/**
 * Opens Chrome's chooser; must run inside a click. Filters on the name prefix only: Polar puts
 * its manufacturer ID (0x006B) in the advertisement, but a filter that also demands it hides the
 * sensor if the ID sits in the scan response instead, and then the remote user is stuck.
 */
export function chooseSensor(bluetooth = navigator.bluetooth) {
  return bluetooth.requestDevice({ filters: [{ namePrefix: 'Polar Sense' }], optionalServices: OPTIONAL_SERVICES });
}

/** Settings to request for a stream, from what the sensor offers. */
export function pickSettings(key, offered, mode, magRate = 20) {
  const pick = (list, want) => {
    if (!list?.length) return undefined;
    if (want === 'max') return Math.max(...list);
    return list.includes(want) ? want : list[0];
  };
  const wantRate = mode === 'max' ? 'max' : { ppg: 55, acc: 52, gyro: 52, mag: magRate }[key];
  const s = {
    sampleRate: pick(offered.sampleRate, wantRate),
    resolution: pick(offered.resolution, 'max'),
    range: pick(offered.range, 'max'),
    rangeMilliunit: pick(offered.rangeMilliunit, 'max'),
    channels: pick(offered.channels, 'max'),
  };
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  return s;
}

export class LinkError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'LinkError'; this.code = code; Object.assign(this, extra); }
}
const FATAL = new Set(['noPick', 'btOff', 'blocked', 'charging', 'mtu', 'closed']);

function classify(e, step) {
  if (e instanceof LinkError) return e;
  const m = String(e?.message || e);
  if (e?.name === 'NotFoundError' && /cancel/i.test(m)) return new LinkError('noPick', m);
  if (e?.name === 'NotFoundError' && /adapter|not available|powered/i.test(m)) return new LinkError('btOff', m);
  if (e?.name === 'SecurityError') return new LinkError('blocked', m);
  if (e?.name === 'NetworkError' || /disconnected|not connected/i.test(m)) return new LinkError('dropped', m);
  return new LinkError('refused', `${step}: ${e?.name ? e.name + ': ' : ''}${m}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_MS = [0, 500, 1000, 2000, 4000];
// Another phone or app on the same sensor can start its own raw stream, which stops ours while the link
// stays up. Silence this long on the raw data while streaming means that, and the link takes the sensor back.
const SILENT_MS = 3000, TAKEBACKS_PER_MIN = 2; // the third take within a minute gives up and asks for the other app to close
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const copy = (dv) => new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new LinkError('dropped', `${what} timed out after ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

export class SensorLink {
  /**
   * @param {BluetoothDevice} device
   * @param {{mode?: 'polar'|'max', settleMs?: number, magRate?: number,
   *   onPacket?: (kind: 'pmd'|'hr'|'battery'|'cp', bytes: Uint8Array, rxMs: number) => void,
   *   onStream?: (key: string, cfg: object) => void, onState?: (s: object) => void}} o
   */
  constructor(device, o = {}) {
    this.device = device;
    this.mode = o.mode || 'polar';
    this.settleMs = o.settleMs ?? 2000;
    this.magRate = o.magRate ?? 20;
    this.onPacket = o.onPacket || (() => {});
    this.onStream = o.onStream || (() => {});
    this.onState = o.onState || (() => {});
    this.state = 'idle';            // idle, connecting, streaming, failed, reconnecting, disconnected
    this.steps = {};                // name -> { state, ms, attempts }
    this.log = [];                  // for the debug bundle
    this.error = null;
    this.failedAt = null;
    this.reconnectAttempt = 0;
    this.userClosed = false;
    this.streams = {};
    this.features = null;
    this.batteryPct = null;
    this.sdkOn = false;
    this.waiters = [];
    this.more = null;
    this.lastPmd = 0;
    this.takebacks = [];            // times of recent take backs, to stop a tug of war
    this.takenBack = 0;
    this.onCp = (e) => this.#cpNotification(copy(e.target.value));
    this.onData = (e) => { this.lastPmd = performance.now(); this.onPacket('pmd', copy(e.target.value), this.lastPmd); };
    this.onHr = (e) => this.onPacket('hr', copy(e.target.value), performance.now());
    this.onBatt = (e) => this.#battery(copy(e.target.value));
    device.addEventListener('gattserverdisconnected', () => this.#dropped());
    this.#resetSteps();
  }

  get name() { return this.device.name; }

  /** Run the connect steps, from the start or from `from`. Resolves when every stream runs. */
  run(from = null) {
    if (this.running) return this.running;
    this.userClosed = false;
    const names = stepsFor(this.mode);
    let i = from ? Math.max(0, names.indexOf(from)) : 0;
    if (!this.device.gatt.connected) i = 0; // a lost link means everything after connect is gone too
    for (const n of names.slice(i)) this.steps[n] = { state: 'todo' };
    if (this.state !== 'reconnecting') this.state = 'connecting';
    this.error = null; this.failedAt = null;
    this.t0 = performance.now();
    this.#emit();
    this.running = (async () => {
      for (; i < names.length; i++) await this.#runStep(names[i]);
      this.state = 'streaming'; this.reconnectAttempt = 0;
      this.#log('ok', 'all streams running');
      this.#watch();
      this.#emit();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Retry after a failure: carries on from the failed step. */
  retry() { return this.run(this.failedAt); }

  async disconnect() {
    this.userClosed = true;
    clearInterval(this.battTimer); clearInterval(this.watchTimer);
    this.#rejectWaiters(new LinkError('closed', 'closed by user'));
    try { this.device.gatt.disconnect(); } catch { /* already gone */ }
    this.state = 'disconnected';
    this.#emit();
  }

  /** Switch Polar mode <-> Max rate mode on a running link. */
  async setMode(mode) {
    if (mode === this.mode) return;
    await this.#stopAll();
    this.mode = mode;
    this.#resetSteps();
    this.steps.connected = this.steps.settled = this.steps.battery = { state: 'done' };
    return this.run(mode === 'max' ? 'pmd' : 'hr');
  }

  // ---------- steps ----------
  async connected() { this.server = await withTimeout(this.device.gatt.connect(), 15000, 'Connecting'); }
  async settled() { await sleep(this.settleMs); }

  async battery() {
    const ch = await (await this.server.getPrimaryService(BATTERY_SERVICE)).getCharacteristic(BATTERY_LEVEL);
    this.#battery(copy(await ch.readValue()));
    if (ch.properties.notify) {
      ch.addEventListener('characteristicvaluechanged', this.onBatt);
      await ch.startNotifications().catch(() => {});
    } else {
      clearInterval(this.battTimer);
      this.battTimer = setInterval(() => { ch.readValue().then((v) => this.#battery(copy(v)), () => {}); }, 5 * 60 * 1000);
    }
  }

  async hr() {
    const ch = await (await this.server.getPrimaryService(HEART_RATE_SERVICE)).getCharacteristic(HEART_RATE_MEASUREMENT);
    ch.addEventListener('characteristicvaluechanged', this.onHr);
    await ch.startNotifications();
  }

  async pmd() {
    const svc = await this.server.getPrimaryService(PMD_SERVICE_UUID);
    const chars = await svc.getCharacteristics();
    const cp = chars.find((c) => (c.properties.write || c.properties.writeWithoutResponse) && (c.properties.indicate || c.properties.notify));
    const data = chars.find((c) => c !== cp && c.properties.notify);
    if (!cp || !data) throw new LinkError('refused', `raw data characteristics not found (${chars.map((c) => c.uuid).join(', ')})`);
    if (cp.uuid !== PMD_CONTROL_POINT_UUID || data.uuid !== PMD_DATA_UUID) this.#log('note', `unexpected PMD characteristic ids: control ${cp.uuid}, data ${data.uuid}`);
    cp.addEventListener('characteristicvaluechanged', this.onCp);
    await cp.startNotifications();
    data.addEventListener('characteristicvaluechanged', this.onData);
    await data.startNotifications();
    this.cp = cp; this.data = data;
    try { this.features = parseFeatures(copy(await cp.readValue())); this.#log('note', `features: ${this.features.join(',')}`); } catch (e) { this.#log('note', `features not readable: ${e.message}`); }
  }

  async sdk() {
    await this.#command(Uint8Array.of(OpCode.START, MT.SDK_MODE), OpCode.START, MT.SDK_MODE, 'Max rate mode', true);
    this.sdkOn = true;
  }

  ppg() { return this.#startStream('ppg'); }
  acc() { return this.#startStream('acc'); }
  gyro() { return this.#startStream('gyro'); }
  mag() { return this.#startStream('mag'); }
  ppi() { return this.#startStream('ppi'); }

  // ---------- internals ----------
  async #startStream(key) {
    const type = STREAM_TYPES[key];
    if (this.features && !this.features.includes(type)) {
      if (key === 'mag') { this.#log('note', 'this sensor has no magnetometer stream, skipped'); return; }
      throw new LinkError('refused', `this sensor does not offer ${key.toUpperCase()}`);
    }
    let chosen = {};
    if (key !== 'ppi') {
      const r = await this.#command(buildGetSettings(type), OpCode.GET_SETTINGS, type, key);
      if (!r.settings) throw new LinkError('refused', `${key} settings unreadable: ${r.settingsError}`);
      chosen = pickSettings(key, r.settings, this.mode, this.magRate);
      this.#log('note', `${key} offered ${JSON.stringify(r.settings)}, chose ${JSON.stringify(chosen)}`);
    }
    let r = await this.#command(buildStart(type, chosen), OpCode.START, type, key, true);
    if (r.status === 6) { // already running from before: restart it so the start response gives us its factor
      await this.#command(buildStop(type), OpCode.STOP, type, key, true);
      r = await this.#command(buildStart(type, chosen), OpCode.START, type, key);
    }
    const cfg = { key, measType: type, sampleRate: chosen.sampleRate ?? 0, factor: r.settings?.factor?.[0] ?? 1, settings: chosen, mode: this.mode };
    this.streams[key] = cfg;
    this.onStream(key, cfg);
  }

  async #stopAll() {
    for (const cfg of Object.values(this.streams)) {
      await this.#command(buildStop(cfg.measType), OpCode.STOP, cfg.measType, cfg.key, true).catch((e) => this.#log('error', `stop ${cfg.key}: ${e.message}`));
    }
    this.streams = {};
    if (this.sdkOn) {
      await this.#command(Uint8Array.of(OpCode.STOP, MT.SDK_MODE), OpCode.STOP, MT.SDK_MODE, 'Max rate mode', true).catch((e) => this.#log('error', `stop SDK mode: ${e.message}`));
      this.sdkOn = false;
    }
  }

  async #command(bytes, op, type, what, allowAlready = false) {
    if (!this.cp) throw new LinkError('refused', 'raw data service not ready');
    const reply = new Promise((resolve, reject) => {
      const w = { op, type, resolve, reject, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new LinkError('refused', `no answer to ${what} command within 6 s`)); }, 6000) };
      this.waiters.push(w);
    });
    this.#log('tx', hex(bytes));
    try { await this.cp.writeValueWithResponse(bytes); } catch (e) {
      const w = this.waiters.find((x) => x.op === op && x.type === type);
      if (w) { clearTimeout(w.timer); this.waiters = this.waiters.filter((x) => x !== w); }
      reply.catch(() => {});
      throw e;
    }
    const r = await reply;
    if (r.success || (allowAlready && r.status === 6)) return r;
    if (r.status === 13) throw new LinkError('charging', r.statusText);
    if (r.status === 10) throw new LinkError('mtu', r.statusText);
    throw new LinkError('streamRefused', r.statusText, { stream: what, meaning: r.statusText, status: r.status });
  }

  #cpNotification(bytes) {
    this.onPacket('cp', bytes.slice(), performance.now()); // a copy: the receiver may transfer (detach) what it gets
    this.#log('rx', hex(bytes));
    let r;
    try { r = parseControlPointResponse(bytes); } catch (e) { this.#log('error', e.message); return; }
    if (r.type === 'measurementStopped') {
      this.#log('warn', `sensor stopped streams by itself: ${r.measTypes.join(',')}`);
      if (this.state === 'streaming') { this.takeBack('the sensor stopped our streams'); return; }
      this.state = 'failed'; this.error = new LinkError('refused', 'The sensor stopped sending data by itself.');
      this.failedAt = 'pmd'; this.#emit();
      return;
    }
    if (r.more) { this.more = this.more ? concat(this.more, r.parameters) : r.parameters; return; }
    if (this.more) {
      const all = concat(this.more, r.parameters); this.more = null;
      try { r.settings = parseSettings(all); r.settingsError = null; } catch (e) { r.settings = null; r.settingsError = e.message; }
    }
    const i = this.waiters.findIndex((w) => w.op === r.opCode && w.type === r.measType);
    if (i < 0) { this.#log('note', `unrequested control point answer op ${r.opCode} type ${r.measType}`); return; }
    const [w] = this.waiters.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(r);
  }

  #battery(bytes) {
    this.onPacket('battery', bytes.slice(), performance.now());
    try { const b = parseBatteryLevel(bytes); if (b.valid) { this.batteryPct = b.percent; this.#emit(); } } catch (e) { this.#log('error', e.message); }
  }

  async #runStep(name) {
    const started = performance.now();
    this.steps[name] = { state: 'running' };
    this.#emit();
    let last;
    for (let a = 0; a < BACKOFF_MS.length; a++) {
      if (BACKOFF_MS[a]) { this.#log('retry', `${name}: try ${a + 1} in ${BACKOFF_MS[a]} ms`); this.steps[name] = { state: 'running', attempts: a + 1 }; this.#emit(); await sleep(BACKOFF_MS[a]); }
      if (this.userClosed) throw new LinkError('closed', 'closed by user');
      try {
        await this[name]();
        this.steps[name] = { state: 'done', ms: Math.round(performance.now() - this.t0), attempts: a + 1 };
        this.#log('step', `${name} done after ${a + 1} ${a ? 'tries' : 'try'}`);
        this.#emit();
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
    clearInterval(this.battTimer); clearInterval(this.watchTimer);
    this.#rejectWaiters(new LinkError('dropped', 'link lost'));
    this.cp = this.data = null; this.streams = {}; this.sdkOn = false; this.more = null;
    this.#resetSteps();
    if (this.userClosed) { this.state = 'disconnected'; this.#emit(); return; }
    this.state = 'reconnecting';
    this.#emit();
    this.#reconnect();
  }

  async #reconnect() {
    while (!this.userClosed && this.state === 'reconnecting') {
      this.reconnectAttempt++;
      this.#emit();
      try { await this.run('connected'); return; } catch (e) { if (e.code === 'closed') return; this.state = 'reconnecting'; }
      await sleep(Math.min(10000, 1000 * 2 ** Math.min(this.reconnectAttempt, 4)));
    }
  }

  /** Another central took the raw streams: stop whatever runs on the sensor and start ours again. */
  async takeBack(why) {
    if (this.running || this.state !== 'streaming') return;
    const t = performance.now();
    this.takebacks = this.takebacks.filter((x) => t - x < 60000);
    if (this.takebacks.length >= TAKEBACKS_PER_MIN) { // a tug of war: tell the user instead
      clearInterval(this.watchTimer);
      this.#log('error', `taken ${this.takebacks.length} times in a minute, giving up: ${why}`);
      this.state = 'failed'; this.failedAt = 'pmd';
      this.error = new LinkError('contested', 'another device keeps taking the sensor');
      this.#emit();
      return;
    }
    this.takebacks.push(t); this.takenBack++;
    this.#log('warn', `taking the sensor back: ${why}`);
    this.state = 'connecting'; this.#emit();
    for (const type of Object.values(STREAM_TYPES)) await this.#command(buildStop(type), OpCode.STOP, type, 'stop', true).catch(() => {});
    await this.#command(Uint8Array.of(OpCode.STOP, MT.SDK_MODE), OpCode.STOP, MT.SDK_MODE, 'Max rate mode', true).catch(() => {});
    this.streams = {}; this.sdkOn = false;
    this.run('pmd').catch(() => { /* the slot shows the error and a Retry button */ });
  }

  #watch() {
    clearInterval(this.watchTimer);
    this.lastPmd = performance.now();
    this.watchTimer = setInterval(() => {
      if (this.state !== 'streaming' || this.running || !this.device.gatt.connected) return;
      if (performance.now() - this.lastPmd > SILENT_MS) this.takeBack(`no raw data for ${SILENT_MS / 1000} s`);
    }, 1000);
  }

  #rejectWaiters(err) { for (const w of this.waiters) { clearTimeout(w.timer); w.reject(err); } this.waiters = []; }
  #resetSteps() { this.steps = Object.fromEntries(stepsFor(this.mode).map((n) => [n, { state: 'todo' }])); }
  #log(kind, msg) { this.log.push({ t: Math.round(performance.now()), kind, msg }); if (this.log.length > 800) this.log.splice(0, 200); }
  #emit() {
    this.onState({
      state: this.state, mode: this.mode, battery: this.batteryPct, reconnectAttempt: this.reconnectAttempt, takenBack: this.takenBack,
      failedAt: this.failedAt, error: this.error && { code: this.error.code, message: this.error.message, stream: this.error.stream, meaning: this.error.meaning },
      steps: stepsFor(this.mode).map((n) => ({ name: n, ...this.steps[n] })),
      streams: { ...this.streams },
    });
  }
}
