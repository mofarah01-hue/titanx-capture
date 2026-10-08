// The simulated board's MAX30101 register file, and a fake of the firmware's serial shell that reads and
// writes it with the same command syntax and replies as Zephyr's i2c shell (see core/senswear/shell.js).
// The fake board's PPG signal follows the LED current registers, so the register editor visibly works in sim.

import { I2C_ADDR } from '../senswear/max30101.js';

// Start values: what the stock firmware's max30101_config() writes (firmware 5c4f855b, see
// core/senswear/firmware-facts.js), decoded from its bit fields, not read from a real chip.
export const MAX30101_POR = {
  0x08: 0x96,             // 16 sample averaging, rollover on, almost full at 6 empty
  0x09: 0x07,             // multi LED mode, running
  0x0a: 0x5e,             // 8192 nA range, 3200 sps, 215 µs (outside the datasheet's tables; see Compare)
  0x0c: 0x08, 0x0d: 0x08, 0x0e: 0x03, 0x0f: 0x00, // 1.6, 1.6, 0.6 mA (the driver writes LED1 and LED2 swapped)
  0x10: 0x32,             // proximity LED 10 mA
  0x11: 0x12, 0x12: 0x03, // slot 1 IR, slot 2 red, slot 3 green
  0xfe: 0x03, 0xff: 0x15, // revision ID: sim value; the firmware never reads it
};

export function regFile(init) {
  const m = new Map(Object.entries(init).map(([k, v]) => [Number(k), v]));
  return { get: (r) => m.get(r) ?? 0, set: (r, v) => { if (r === 0x09 && v & 0x40) { m.clear(); for (const [k, x] of Object.entries(init)) m.set(Number(k), x); return; } m.set(r, v & 0xff); } };
}

/** Same interface as ShellPort, wired to a fake board's registers. */
export class FakeShellPort {
  constructor(o = {}) { this.onLine = o.onLine || (() => {}); this.board = null; this.bus = 'i2c@sim'; }
  get open() { return !!this.board; }
  async connect(_baud, boards) {
    this.board = boards?.[0] || null;
    if (!this.board) throw new Error('No simulated board to talk to');
    this.onLine('Serial port open (simulated debug board)', 'info');
    for (const l of ['*** Booting nRF Connect SDK (simulated) ***', '[00:00:00.120,000] <inf> senswear: Sens Wear (OOB) advertising', 'uart:~$ ']) this.onLine(l, 'rx');
  }
  async close() { this.board = null; this.onLine('Serial port closed', 'info'); }
  async run(cmd) {
    this.onLine(cmd, 'tx');
    await new Promise((r) => setTimeout(r, 15));
    const out = this.#exec(cmd.trim().split(/\s+/));
    for (const l of out) this.onLine(l, 'rx');
    return out;
  }
  #exec([c, sub, bus, addr, reg, val]) {
    if (c === 'help') return ['Available commands:', '  i2c      :I2C commands', '  kernel   :Kernel commands', '  device   :Device commands'];
    if (c === 'kernel' && sub === 'version') return ['Zephyr version 4.x (simulated)'];
    if (c === 'device' && sub === 'list') return ['devices:', `- ${this.bus} (READY)`, '- max30101@57 (READY)'];
    if (c !== 'i2c') return [`${c}: command not found`];
    if (sub === 'scan') return ['     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f', `50: -- -- -- -- -- -- -- ${I2C_ADDR.toString(16)} -- -- -- -- -- -- -- --`, `1 devices found on ${bus}`];
    if (bus !== this.bus) return [`I2C: Device driver ${bus} not found.`];
    if (parseInt(addr, 16) !== I2C_ADDR) return ['Failed to read from device: 0x5f'];
    const r = parseInt(reg, 16);
    if (sub === 'read_byte') return [`Output: 0x${this.board.regs.get(r).toString(16)}`];
    if (sub === 'write_byte') { this.board.regs.set(r, parseInt(val, 16)); return []; }
    return [`i2c ${sub}: not simulated`];
  }
}
