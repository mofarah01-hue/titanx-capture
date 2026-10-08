// Engineering view: everything about one connected sensor that the athlete facing views leave out.
// SensWear: board and power facts, stream switches and rates, LED and vibration, the serial console of
// the debug board, the MAX30101 register editor, firmware. Polar: what Polar lets us see and change.
// Both: the signal cleaning chain, from raw PPG to our PC side heart rate, drawn live.
import { S, now, slotIds, athleteName, pcHr, liveHr } from '../state.js';
import { esc, setHTML, setText, $, $$, toast } from '../ui.js';
import { drawLane } from '../draw.js';
import { ShellPort, serialSupported, i2cRead, i2cWrite } from '../../core/senswear/shell.js';
import { FakeShellPort } from '../../core/sim/fake-max30101.js';
import * as MX from '../../core/senswear/max30101.js';
import { POWER_SOURCE, CHARGE_STATE, CHARGE_LEVEL, PPG_ADC_MAX } from '../../core/senswear/protocol.js';
import { FW } from '../../core/senswear/firmware-facts.js';

let root = null, ctx = null, sel = null, lanes = [], shell = null;
const conLines = [];
const regVal = new Map();     // register address -> value read from the chip
const pending = new Map();    // register address -> value edited, not yet written

const hex2 = (n) => `0x${n.toString(16).padStart(2, '0').toUpperCase()}`;
const sw = () => S.kind === 'senswear';

export function mountEng(container, c) {
  root = container; ctx = c;
  const ids = slotIds().filter((id) => S.links.has(id));
  if (!sel || !ids.includes(sel)) sel = ids[0] || null;
  root.innerHTML = `<div class="page eng">
    <div class="eng-h"><h2>Engineering</h2>
      <label class="field inline">Sensor<select data-k="dev">${ids.map((id) => `<option value="${id}" ${id === sel ? 'selected' : ''}>${esc(athleteName(id))} · ${id}</option>`).join('') || '<option>None connected</option>'}</select></label>
      <span class="dim">${sw() ? 'SensWear: open firmware, so rates, LED currents and registers can be changed here.' : 'Polar Verity Sense: closed firmware. What it allows is below; the Compare tab lists the rest.'}</span></div>
    ${sel ? body() : `<div class="card"><h2>No sensor connected</h2><p>Connect one from the Live tab, then come back.</p></div>`}
  </div>`;
  $('[data-k="dev"]', root)?.addEventListener('change', (e) => { sel = e.target.value; mountEng(root, ctx); });
  if (!sel) return;
  lanes = signalLanes(S.links.get(sel));
  const cs = $$('canvas.lane-c', root); lanes.forEach((L, i) => { L.c = cs[i]; });
  wire();
  refreshEng(now());
}

function body() {
  const cards = [boardCard(), streamsCard(), signalCard()];
  if (sw()) cards.push(outputsCard(), consoleCard(), regsCard(), firmwareCard());
  else cards.push(polarLimitsCard());
  return `<div class="eng-grid">${cards.join('')}</div>`;
}

// ---------- cards ----------
const boardCard = () => `<div class="box"><h3>${sw() ? 'BOARD' : 'SENSOR'}</h3><table class="kv" data-k="board"></table>
  ${sw() ? '<div class="row"><button class="btn" data-a="clock">Set board clock to this PC</button></div>' : ''}</div>`;

const streamsCard = () => `<div class="box"><h3>STREAMS · MEASURED FROM THE SENSOR'S OWN TIME STAMPS</h3>
  <table class="health"><thead><tr><th>Stream</th><th>${sw() ? 'Expected' : 'Set'}</th><th>Measured</th><th>Arrival</th><th>Lost</th></tr></thead><tbody data-k="rates"></tbody></table>
  <p data-k="sat"></p>
  ${sw() ? `<p class="dim">${esc(FW.ppg.notes[1])} Stock PPG setup from the firmware source: ${FW.ppg.sps} sps, ${FW.ppg.averaging} sample averaging, ${FW.ppg.pulseUs} µs pulses, LEDs red ${FW.ppg.ledMa.red}, IR ${FW.ppg.ledMa.ir}, green ${FW.ppg.ledMa.green} mA.</p>` : ''}
  ${sw() ? `<div class="ctl">
    <label><input type="checkbox" data-c="ppg"> PPG sampling on</label>
    <label><input type="checkbox" data-c="ppgIrq"> PPG one interrupt per sample <span class="dim">(stops and restarts PPG)</span></label>
    <label><input type="checkbox" data-c="imu"> IMU streams on <span class="dim">(off after the board boots)</span></label>
    <label class="field inline">IMU batch period<input type="number" min="1" max="1000" step="1" data-c="drainMs" style="width:90px"> ms <button class="btn" data-a="drain">Apply</button></label>
    <label class="field inline">Skin temperature every<select data-c="tempS"><option value="0">off</option><option value="60">1 min</option><option value="300">5 min</option><option value="600">10 min</option></select></label>
    <p class="dim">The stock firmware reads "off" here after boot but still measures every minute until a value is written.</p>
    <p class="dim">The batch period changes how often IMU samples are sent, not how often they are taken. Sample rate, LED current and pulse width live in the PPG chip's registers: see the register editor.</p>
  </div>` : `<p class="dim">Polar mode streams PPG at 55 Hz and motion at 52 Hz with Polar's heart rate and beat to beat. Max rate mode (Live, full monitor) raises PPG to 176 Hz and ACC and GYRO to 416 Hz and turns Polar's heart rate off. Those are the only rates Polar offers.</p>`}
</div>`;

const signalCard = () => `<div class="box wide"><h3>SIGNAL CLEANING · GREEN PPG TO HEART RATE, ON THIS PC</h3>
  <div class="lanes">${['RAW COUNTS', 'BASELINE REMOVED (WHAT THE LIVE VIEW SHOWS)', 'BAND-PASS, BEATS MARKED', 'PC HR AGAINST POLAR HR'].map((n, i) => `<div class="lane"><div class="lane-h"><span class="ln"><span>${n}</span></span><span class="lr" data-k="sl${i}"></span></div><canvas class="lane-c" style="--lh:${i === 3 ? 90 : 70}px"></canvas></div>`).join('')}</div>
  <div class="ctl"><label class="field inline">Band-pass<input type="number" step="0.1" min="0.2" max="2" data-k="lo" value="0.7" style="width:70px"> to <input type="number" step="0.1" min="2" max="8" data-k="hi" value="3.6" style="width:70px"> Hz <button class="btn" data-a="band">Apply</button></label>
  <span class="dim" data-k="hrwhy"></span></div>
  <p class="dim">Runs in this page on the green channel (Polar channel 0, SensWear green). Code: core/algo/filters.js, core/algo/hr.js. Recordings keep the raw counts, so any algorithm can be rerun on them later.${sw() ? ` On the chip instead: ${esc(FW.onChip)}` : ' Polar runs its own algorithm on the sensor; ours cannot run there.'}</p>
</div>`;

const outputsCard = () => `<div class="box"><h3>OUTPUTS</h3>
  <div class="ctl"><label class="field inline">Status LED<input type="color" data-k="led" value="#000000"> <button class="btn" data-a="led">Set</button> <button class="btn quiet" data-a="ledoff">Off</button></label>
  <label class="field inline">Vibration<button class="btn" data-a="buzz">Short buzz</button><span class="dim" data-k="haptic"></span></label></div></div>`;

const consoleCard = () => `<div class="box wide"><h3>USB CONSOLE · DEBUG BOARD</h3>
  <div class="ctl"><button class="btn primary" data-a="usb">${S.sim ? 'Connect the simulated debug board' : 'Connect the debug board'}</button>
  <label class="field inline">Baud<select data-k="baud">${[115200, 1000000, 921600, 460800, 230400, 57600, 9600].map((b) => `<option ${b === FW.baud ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
  ${['help', 'kernel version', 'device list'].map((c) => `<button class="btn quiet" data-cmd="${c}">${c}</button>`).join('')}<button class="btn quiet" data-a="scan">i2c scan</button></div>
  <pre class="console" data-k="con" aria-live="polite"></pre>
  <form class="ctl" data-k="cmdf"><input data-k="cmd" placeholder="Shell command, e.g. i2c read_byte ${esc(FW.bus)} 57 ff" autocomplete="off" style="flex:1"><button class="btn">Send</button></form>
  <p class="dim">${serialSupported() || S.sim ? 'Chrome asks which COM port: pick the debug board (USB serial). The board prints its log here; the shell runs any command its firmware has.' : 'This browser has no Web Serial. Use Chrome or Edge.'}</p></div>`;

const regsCard = () => `<div class="box wide"><h3>MAX30101 REGISTERS · PPG CHIP, I2C ${hex2(MX.I2C_ADDR)}</h3>
  <div class="ctl"><label class="field inline">I2C bus<input data-k="bus" value="${esc(S.sim ? 'i2c@sim' : FW.bus)}" placeholder="from device list" style="width:150px"></label><button class="btn primary" data-a="readall">Read all</button><span class="dim" data-k="regmsg">Needs the USB console connected.</span></div>
  <div class="ratecheck" data-k="ratecheck"></div>
  <table class="regs"><thead><tr><th>Reg</th><th>Name</th><th>Value</th><th>Fields</th><th></th></tr></thead><tbody data-k="regs">${MX.REGISTERS.map(regRow).join('')}</tbody></table>
  <p class="dim">Writes go through the firmware's i2c shell and are read back. ${esc(FW.driverNote)} Values from the MAX30101 datasheet; LED current 0.2 mA per step, 51.0 mA at 0xFF.</p></div>`;

function regRow(r) {
  const f = r.fields.map((k) => fieldCtl(k, MX.FIELDS[k], r.readOnly)).join('');
  return `<tr data-reg="${r.addr}"><td>${hex2(r.addr)}</td><td>${esc(r.name)}</td><td class="mono" data-k="v">--</td><td class="fields">${f}</td>
    <td>${r.readOnly ? '' : `<button class="btn quiet" data-w="${r.addr}" disabled>Write</button>`}</td></tr>`;
}
function fieldCtl(key, f, ro) {
  const dis = ro || f.readOnly ? 'disabled' : '';
  if (f.current) return `<label class="fctl">${esc(f.name)} <input type="number" min="0" max="51" step="0.2" data-f="${key}" ${dis} style="width:72px"> mA</label>`;
  if (f.values) return `<label class="fctl">${esc(f.name)} <select data-f="${key}" ${dis}>${f.values.map((v) => `<option value="${v.code}">${v.code}: ${esc(v.text)}</option>`).join('')}</select></label>`;
  return `<label class="fctl">${esc(f.name)} <input type="number" min="0" max="${(1 << f.bits) - 1}" data-f="${key}" ${dis} style="width:64px"></label>`;
}

const firmwareCard = () => `<div class="box"><h3>FIRMWARE</h3><table class="kv" data-k="fw"></table>
  <h4>Update over the debug board (USB)</h4><pre class="cmds">${esc(FW.flashSteps)}</pre>
  <h4>Update over Bluetooth</h4><p class="dim">${esc(FW.otaNote)}</p>
  <h4>Debugging</h4><p class="dim">${esc(FW.debugNote)}</p></div>`;

const polarLimitsCard = () => `<div class="box"><h3>WHAT POLAR DOES NOT LET US DO</h3><ul class="plain">
  <li>No register access, no LED current or pulse width control: Polar's firmware sets them.</li>
  <li>Rates only from Polar's fixed list (above); no on chip code of ours.</li>
  <li>Firmware updates only Polar's own, through the Polar Flow app.</li>
  <li>Polar's heart rate algorithm is closed; we get its output, its beat to beat intervals and raw PPG.</li></ul>
  <p class="dim">Side by side with SensWear: the Compare tab.</p></div>`;

function signalLanes(e) {
  const d = e.data;
  return [
    { key: 'ppg', auto: true, minSpan: 50, win: 10, series: [{ buf: d.ppg, ch: 0, color: 'ppg', lw: 1.2 }], empty: 'No PPG yet' },
    { key: 'ppg', auto: true, minSpan: 50, win: 10, series: [{ buf: d.ppgf, ch: 0, color: 'ppg' }], empty: 'No PPG yet' },
    { key: 'bp', auto: true, minSpan: 20, win: 10, series: [{ buf: d.ppgBp, color: 'ppg2' }, { buf: d.beats, color: 'z5', dots: true }], empty: 'Waiting for the measured rate (about 10 s)' },
    { key: 'hr', range: [40, 210], ticks: [60, 120, 180], win: 120, series: [{ buf: d.hr, color: 'polar', dash: true, lw: 1.6, gapS: 12 }, { buf: d.pcHr, color: 'z5', lw: 1.8, gapS: 5 }], empty: 'No heart rate yet' },
  ];
}

// ---------- wiring ----------
function wire() {
  const link = () => S.links.get(sel)?.link;
  const act = async (what, fn) => { try { await fn(); } catch (e) { toast(`${what} failed: ${e.message}`, 7000); } };
  root.addEventListener('change', (ev) => {
    const c = ev.target.dataset.c, l = link(); if (!c || !l) return;
    if (c === 'ppg') act('PPG switch', () => l.setPpg(ev.target.checked));
    if (c === 'ppgIrq') act('PPG interrupt mode', () => l.setPpgIrq(ev.target.checked));
    if (c === 'imu') act('IMU switch', () => l.setImu(ev.target.checked));
    if (c === 'tempS') act('Temperature interval', () => l.setTempInterval(Number(ev.target.value)));
  });
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const a = b.dataset.a, l = link();
    if (a === 'clock') act('Clock', async () => { const c = await l.syncClock(); toast(`Board clock set; now ${c.offsetS.toFixed(2)} s from this PC.`); });
    if (a === 'drain') act('IMU batch period', () => l.setDrainMs(Number($('[data-c="drainMs"]', root).value)));
    if (a === 'led') act('LED', () => { const h = $('[data-k="led"]', root).value; return l.setLed(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)); });
    if (a === 'ledoff') act('LED', () => l.setLed(0, 0, 0));
    if (a === 'buzz') act('Vibration', () => l.haptic([[120, 200], [80, 0], [120, 200]]));
    if (a === 'band') {
      const e = S.links.get(sel), lo = Number($('[data-k="lo"]', root).value), hi = Number($('[data-k="hi"]', root).value);
      if (!(lo > 0 && hi > lo)) { toast('The low edge must be above 0 and below the high edge.'); return; }
      e.algo = { lo, hi }; e.pcEst = null; toast(`Band-pass now ${lo} to ${hi} Hz.`);
    }
    if (a === 'usb') act('USB console', openShell);
    if (a === 'scan') act('i2c scan', () => runCmd(`i2c scan ${$('[data-k="bus"]', root)?.value || FW.bus}`));
    if (b.dataset.cmd) act(b.dataset.cmd, () => runCmd(b.dataset.cmd));
    if (a === 'readall') act('Read registers', readAll);
    if (b.dataset.w) act('Register write', () => writeReg(Number(b.dataset.w)));
  });
  $('[data-k="cmdf"]', root)?.addEventListener('submit', (ev) => { ev.preventDefault(); const i = $('[data-k="cmd"]', root); const c = i.value.trim(); if (c) { i.value = ''; act(c, () => runCmd(c)); } });
  $('[data-k="regs"]', root)?.addEventListener('input', (ev) => { const k = ev.target.dataset.f; if (k) fieldEdited(k, ev.target); });
}

// ---------- USB console and registers ----------
function conAdd(line, kind) {
  conLines.push([kind, line]); if (conLines.length > 400) conLines.splice(0, 100);
  const pre = root && $('[data-k="con"]', root);
  if (pre) { pre.textContent = conLines.map(([k, l]) => (k === 'tx' ? `> ${l}` : k === 'info' ? `# ${l}` : l)).join('\n'); pre.scrollTop = pre.scrollHeight; }
}
async function openShell() {
  if (shell?.open) { toast('The console is already connected.'); return; }
  shell = S.sim ? new FakeShellPort({ onLine: conAdd }) : new ShellPort({ onLine: conAdd });
  if (S.sim) await shell.connect(0, ctx.radio()?.devices);
  else await shell.connect(Number($('[data-k="baud"]', root).value));
  setText($('[data-k="regmsg"]', root), 'Console connected. Read all to load the registers.');
}
async function runCmd(c) { if (!shell?.open) throw new Error('connect the debug board first'); return shell.run(c); }

async function readAll() {
  if (!shell?.open) throw new Error('connect the debug board first');
  const bus = $('[data-k="bus"]', root).value.trim();
  if (!bus) throw new Error('fill in the I2C bus name first: run "device list" and use the i2c device the PPG chip sits on (node sys_i2c_peripheral)');
  const id = await i2cRead(shell, bus, MX.I2C_ADDR, 0xff);
  if (id !== MX.PART_ID) throw new Error(`part ID reads ${hex2(id)}, a MAX30101 reads ${hex2(MX.PART_ID)}: wrong bus or address?`);
  for (const r of MX.REGISTERS) regVal.set(r.addr, await i2cRead(shell, bus, MX.I2C_ADDR, r.addr));
  pending.clear();
  for (const r of MX.REGISTERS) showReg(r.addr);
  rateCheck();
  setText($('[data-k="regmsg"]', root), `Read ${MX.REGISTERS.length} registers at ${new Date().toLocaleTimeString()}.`);
}
async function writeReg(addr) {
  const v = pending.get(addr); if (v == null) return;
  const bus = $('[data-k="bus"]', root).value.trim();
  const back = await i2cWrite(shell, bus, MX.I2C_ADDR, addr, v);
  regVal.set(addr, back); pending.delete(addr); showReg(addr); rateCheck();
  toast(back === v ? `${hex2(addr)} is now ${hex2(back)}.` : `Wrote ${hex2(v)} to ${hex2(addr)} but it reads back ${hex2(back)}: the chip or the firmware changed it.`, 7000);
}
function showReg(addr) {
  const tr = $(`tr[data-reg="${addr}"]`, root); if (!tr) return;
  const v = pending.get(addr) ?? regVal.get(addr);
  setText($('[data-k="v"]', tr), v == null ? '--' : `${hex2(v)}${pending.has(addr) ? ' (edited)' : ''}`);
  tr.classList.toggle('edited', pending.has(addr));
  const wb = $('[data-w]', tr); if (wb) wb.disabled = !pending.has(addr);
  for (const inp of $$('[data-f]', tr)) {
    const f = MX.FIELDS[inp.dataset.f]; if (v == null || document.activeElement === inp) continue;
    const x = MX.getField(v, f);
    inp.value = f.current ? MX.paToMa(x).toFixed(1) : String(x);
  }
}
function fieldEdited(key, inp) {
  const f = MX.FIELDS[key], base = pending.get(f.reg) ?? regVal.get(f.reg);
  if (base == null) { toast('Read the registers first.'); return; }
  const code = f.current ? MX.maToPa(Number(inp.value)) : Number(inp.value);
  try { pending.set(f.reg, MX.setField(base, f, code)); } catch (e) { toast(e.message); return; }
  if (pending.get(f.reg) === regVal.get(f.reg)) pending.delete(f.reg);
  showReg(f.reg); rateCheck();
}
function rateCheck() {
  const g = (a) => pending.get(a) ?? regVal.get(a);
  if (g(0x09) == null || g(0x0a) == null) return;
  const mode = MX.getField(g(0x09), MX.FIELDS.MODE), sr = MX.getField(g(0x0a), MX.FIELDS.SPO2_SR), pw = MX.getField(g(0x0a), MX.FIELDS.LED_PW);
  const avg = [1, 2, 4, 8, 16, 32, 32, 32][MX.getField(g(0x08) ?? 0, MX.FIELDS.SMP_AVE)];
  const slots = ['SLOT1', 'SLOT2', 'SLOT3', 'SLOT4'].filter((k) => { const v = g(MX.FIELDS[k].reg); return v != null && [1, 2, 3].includes(MX.getField(v, MX.FIELDS[k])); }).length || 1;
  const r = MX.rateAllowed(mode, sr, pw, slots);
  setHTML($('[data-k="ratecheck"]', root), `<span class="${r.ok ? 'ok' : r.ok === false ? 'bad' : 'warn'}"><b>${r.ok ? 'Allowed' : r.ok === false ? 'Not allowed' : 'Not covered by the datasheet'}</b></span> ${MX.spsOf(sr)} sps at ${MX.pwOf(pw)} µs in ${mode === 7 ? `multi LED mode with ${slots} slot${slots > 1 ? 's' : ''}` : mode === 3 ? 'SpO2 mode' : 'heart rate mode'} (${esc(r.source)}). With ${avg} sample averaging that would be ${(MX.spsOf(sr) / avg).toFixed(1)} samples per second out of the FIFO${r.ok ? '' : ', if the chip reached the set rate; the arrival rate above shows what it delivers'}.`);
}

// ---------- refresh ----------
const kv = (rows) => rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
export function refreshEng(t) {
  if (!root || !sel) return;
  const e = S.links.get(sel); if (!e) return;
  const ls = e.linkState || {}, b = ls.board || {};
  if (sw()) {
    const p = b.power;
    setHTML($('[data-k="board"]', root), kv([
      ['Name', esc(e.device?.name || '--')], ['Link', esc(ls.state || '--')], ['Firmware', esc(b.firmware || '--')],
      ['Boards fitted (firmware build)', esc(b.caps?.shields?.join(', ') || '--')], ['Features', esc(b.caps?.features?.join(', ') || '--')],
      ['Battery', b.battery != null ? `${b.battery} %` : '--'],
      ['Power', p ? esc(`battery ${p.batteryPresent ? 'present' : 'absent'}, USB ${POWER_SOURCE[p.wiredPower]}, ${CHARGE_STATE[p.chargeState]}, level ${CHARGE_LEVEL[p.chargeLevel]}${p.chargingFault ? `, FAULT ${p.chargingFault}` : ''}`) : '--'],
      ['Board clock', b.clock ? `${b.clock.offsetS.toFixed(2)} s from this PC` : '--'],
      ['Notes', esc((b.notes || []).join('; ') || 'none')],
    ]));
    const cfg = ls.cfg || {};
    for (const [k, v] of Object.entries(cfg)) {
      const inp = $(`[data-c="${k}"]`, root); if (!inp || document.activeElement === inp) continue;
      if (inp.type === 'checkbox') inp.checked = !!v; else if (k !== 'led') inp.value = String(v);
    }
    setText($('[data-k="haptic"]', root), b.caps && !b.caps.shields.includes('haptic') ? ' no haptic board in this build' : '');
    setHTML($('[data-k="fw"]', root), kv([['Running', esc(b.firmware || '--')], ['Source', esc(FW.source)], ['Toolchain', esc(FW.toolchain)]]));
  } else {
    setHTML($('[data-k="board"]', root), kv([['Name', esc(e.device?.name || '--')], ['Link', esc(ls.state || '--')], ['Mode', e.mode === 'max' ? 'Max rate (SDK mode)' : 'Polar mode'], ['Battery', ls.battery != null ? `${ls.battery} %` : '--']]));
  }
  const keys = sw() ? ['ppg', 'ppg_red', 'ppg_ir', 'acc', 'gyro', 'quat'] : ['ppg', 'acc', 'gyro', 'mag'];
  setHTML($('[data-k="rates"]', root), keys.map((k) => {
    const s = e.stats?.[k], cfg = e.streams?.[k], lost = s ? s.lost / ((s.samples + s.lost) || 1) : 0;
    const off = s?.hz && cfg?.sampleRate ? Math.abs(s.hz - cfg.sampleRate) / cfg.sampleRate : 0;
    return `<tr><td>${k.replace('_', ' ').toUpperCase()}</td><td>${cfg?.sampleRate ? `${cfg.sampleRate} Hz` : '--'}</td><td class="${off > 0.1 ? 'bad' : off > 0.03 ? 'warn' : ''}">${s?.hz ? `${s.hz.toFixed(2)} Hz` : '--'}</td><td>${s?.arrivalHz ? `${s.arrivalHz.toFixed(2)} Hz` : '--'}</td><td class="${lost > 0.03 ? 'bad' : lost > 0.005 ? 'warn' : ''}">${s ? `${s.lost} (${(lost * 100).toFixed(1)} %)` : '--'}</td></tr>`;
  }).join(''));
  if (sw()) setHTML($('[data-k="sat"]', root), saturation(e, t));
  const p = pcHr(e, t), ref = liveHr(e, t);
  setText($('[data-k="sl3"]', root), `PC ${p ? Math.round(p.bpm) : '--'} bpm${sw() ? '' : ` · Polar ${ref ?? '--'} bpm`}`);
  setText($('[data-k="sl2"]', root), `${e.pcEst ? `${e.pcEst.fs.toFixed(1)} Hz, ${e.algo?.lo ?? 0.7} to ${e.algo?.hi ?? 3.6} Hz` : ''}`);
  setText($('[data-k="hrwhy"]', root), e.pcEst?.status?.why || '');
}

/** Any PPG colour sitting at the 18 bit ceiling in the last 2 s: the pulse is clipped away. */
function saturation(e, t) {
  const hit = [['green', e.data.ppg], ['red', e.data.ppg_red], ['IR', e.data.ppg_ir]].map(([n, b]) => {
    let k = 0, at = 0; for (let i = b.t.length - 1; i >= 0 && b.t[i] > t - 2; i--) { k++; if (b.v[i * b.ch] >= PPG_ADC_MAX) at++; }
    return k && at / k > 0.05 ? `${n} ${Math.round((at / k) * 100)} %` : null;
  }).filter(Boolean);
  return hit.length ? `<b class="bad">PPG at full scale (${PPG_ADC_MAX} counts): ${hit.join(', ')} of the last 2 s.</b> The pulse is clipped away. Lower that LED's current or raise the ADC range (register editor).` : '';
}

export function drawEng(t) { if (root && sel) for (const L of lanes) if (L.c) drawLane(L.c, L, t); }
export const unmountEng = () => { root = null; lanes = []; };
