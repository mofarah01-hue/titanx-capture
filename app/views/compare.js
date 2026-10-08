// Compare: what Polar Verity Sense and SensWear can and cannot do, side by side, with where each fact
// comes from, and a live column with what the sensor connected to this page measures right now.
// Facts are from documents and source code unless the row says measured; SensWear facts come from
// core/senswear/firmware-facts.js. Nothing here is a claim about accuracy.
import { S, now, pcHr, liveHr } from '../state.js';
import { esc, setHTML } from '../ui.js';
import { FW } from '../../core/senswear/firmware-facts.js';

const Y = 'yes', N = 'no', P = 'partial', F = 'needs firmware', U = 'unverified';

// [topic, polar status, polar text, senswear status, senswear text, source, live key]
const ROWS = [
  ['Form', Y, 'Finished pod with battery and button', P, 'Bare flex boards; your kit has no battery or enclosure', 'Kit photos; SensWear README'],
  ['Heart rate on the sensor', Y, "Polar's own algorithm; updates every 5 s once beat to beat runs", N, 'None: raw light counts only', 'Polar SDK; SensWear SDK VALIDATION.md', 'hr'],
  ['Beat to beat intervals', Y, 'PPI, about 25 s after start', N, 'None; our PC algorithm finds beats in the raw signal', 'Polar SDK; this app'],
  ['Raw PPG', Y, '3 green channels and ambient, 55 Hz; 176 Hz in Max rate mode (Polar HR off)', U, `Green, red and IR, 18 bit counts, "200 Hz" from ${FW.ppg.sps} sps over ${FW.ppg.averaging} averaged; that setting is outside the datasheet tables, so the real rate needs measuring`, 'Polar SDK; firmware max30101_config.h; MAX30101 Tables 15, 16', 'ppg'],
  ['PPG colours', P, 'Green only', Y, 'Green, red and infrared (SpO2 possible later, D21 keeps it out of the MVP)', 'Datasheets'],
  ['Motion', Y, 'ACC and GYRO 52 Hz (416 Hz in Max rate), MAG 20 Hz (100 Hz)', P, 'BHI360: ACC (gravity included), GYRO (no scale declared) and orientation at 100 Hz, off at boot; no magnetometer fitted; gesture and activity events', 'Polar SDK; firmware bhi360.c', 'acc'],
  ['Skin temperature', N, 'None', Y, 'MAX30208 every minute', 'Firmware oob_main.c'],
  ['Change sample rates', P, 'Only from Polar\'s fixed list', F, 'Stock firmware: PPG and IMU rates fixed at build time; BLE switches streams on and off only', 'Firmware audit'],
  ['Change LED currents', N, 'Polar sets them', F, 'MAX30101 allows 0 to 51 mA in 0.2 mA steps per LED; the stock firmware exposes no control and writes LED1 and LED2 swapped', 'MAX30101 p. 20; firmware max30101.c'],
  ['Read and write chip registers', N, 'No', F, 'Stock builds have no shell, and the debug board may not pass PC to board serial data; needs a register service in the firmware (or the editor works in sim now)', 'CMakePresets.json; debugprobe config'],
  ['Our algorithm on the sensor', N, "Polar's firmware is closed", F, `Open firmware: ${FW.onChip}`, 'Firmware source'],
  ['Signal cleaning', Y, 'On this PC: band-pass, beat detection, PC HR; raw kept in the recording', Y, 'Same, on this PC', 'This app, core/algo', 'pc'],
  ['Firmware updates', P, "Polar's own, through the Polar Flow app", P, 'Over SWD with the debug board only; no over the air update (no bootloader)', 'Firmware sysbuild.conf, .vscode/tasks.json'],
  ['Debugging', N, 'No', Y, 'SWD step debugging and a serial log at 921600 baud through the debug board', 'Debug board firmware'],
  ['Time stamps', Y, 'Sensor clock per frame, ns', P, 'PPG in ms, filled in from the assumed rate; IMU in µs; clock restarts at 2026-01-01 on boot (this app sets it on connect)', 'Firmware max30101.c, oob_main.c'],
  ['Lost data detection', Y, 'From frame time stamps', P, 'From time stamp jumps only; no sequence numbers; delivery best effort', 'Firmware ppg_lbs.c, device_manager.c', 'lost'],
  ['Battery', Y, 'Built in', P, 'None in the kit; charges at 100 mA, so a cell of 100 mAh or more, or change the firmware; the gauge is set for 23 mAh', 'FINDINGS.md B5, B6'],
  ['Open source', P, 'SDK open, firmware closed', Y, 'Hardware, firmware, SDKs and apps, MIT', 'GitHub Sens-Wear'],
  ['Tested on the real sensor', U, 'Not yet with this app', U, 'Not yet with this app; SensWear\'s own web app README says physical Bluetooth is unverified', 'STATUS.md; web-app README'],
];

const chip = (s) => `<span class="chip ${{ yes: 'ok', no: 'bad', partial: 'warn', 'needs firmware': 'fw', unverified: 'unv' }[s]}">${s}</span>`;
let root = null;

export function mountCompare(container) {
  root = container;
  root.innerHTML = `<div class="page compare"><div class="card">
    <span class="eyebrow">POLAR VERITY SENSE · SENSWEAR</span><h2>What each can and cannot do</h2>
    <p class="dim">From documents and source code, read 2026-10-08, unless the live column shows a measurement. "Needs firmware" means SensWear's open firmware would have to be changed and flashed; Polar's cannot be.</p>
    <table class="cmp"><thead><tr><th>What</th><th>Polar Verity Sense</th><th>SensWear, stock firmware</th><th>Live on this page (${S.kind === 'senswear' ? 'SensWear' : 'Polar'})</th><th>Source</th></tr></thead>
    <tbody>${ROWS.map(([what, ps, pt, ss, st, src, key]) => `<tr><th>${esc(what)}</th><td>${chip(ps)} ${esc(pt)}</td><td>${chip(ss)} ${esc(st)}</td><td data-live="${key || ''}" class="dim">${key ? '--' : ''}</td><td class="dim">${esc(src)}</td></tr>`).join('')}</tbody></table>
  </div></div>`;
  refreshCompare(now());
}

export function refreshCompare(t) {
  if (!root) return;
  const e = [...S.links.values()].find((x) => x.linkState?.state === 'streaming');
  const v = {};
  if (e) {
    const ppg = e.stats?.ppg, acc = e.stats?.acc;
    v.ppg = ppg?.hz ? `${ppg.hz.toFixed(1)} Hz by time stamps, ${ppg.arrivalHz ? ppg.arrivalHz.toFixed(1) : '--'} Hz arriving` : 'waiting';
    v.acc = acc?.hz ? `${acc.hz.toFixed(1)} Hz` : e.kind === 'senswear' ? 'off or waiting' : 'waiting';
    const h = liveHr(e, t), p = pcHr(e, t);
    v.hr = h != null ? `${h} bpm from the sensor` : e.kind === 'senswear' ? 'none (as expected)' : 'waiting';
    v.pc = p ? `PC HR ${Math.round(p.bpm)} bpm, quality ${(p.quality * 100).toFixed(0)} %` : e.pcEst?.status?.why || 'waiting';
    const lost = Object.values(e.stats || {}).reduce((a, s) => a + (s.lost || 0), 0);
    v.lost = `${lost} samples so far`;
  }
  for (const td of root.querySelectorAll('[data-live]')) { const k = td.dataset.live; if (k) setHTML(td, esc(e ? v[k] ?? '--' : 'No sensor streaming')); }
}
export const unmountCompare = () => { root = null; };
