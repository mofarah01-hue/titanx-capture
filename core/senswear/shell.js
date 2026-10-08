// The SensWear firmware's log and command shell over the debug board's USB serial port, through Chrome's
// Web Serial API (Chrome or Edge on Windows and macOS; one chooser click picks the COM port). It gives
// what Bluetooth does not: the boot log, register reads and writes through Zephyr's i2c shell, and any
// other shell command. ShellPort runs one command at a time and returns the lines it printed.
//
// Zephyr i2c shell (drivers/i2c/i2c_shell.c, main branch, read 2026-10-08; check against the nRF Connect
// SDK version the firmware is built with): every number is hex; the register's byte width comes from the
// number of digits typed, so registers are always sent as two digits. read_byte prints "Output: 0x%x";
// writes print nothing on success; failures print "Failed to read from device: ..." or "Failed to write
// to device: ...".

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;   // the shell colours its output with VT100 codes
const enc = new TextEncoder();

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class ShellPort {
  /** @param {{onLine?: (line: string, kind: 'rx'|'tx'|'info') => void, prompt?: RegExp}} o */
  constructor(o = {}) {
    this.onLine = o.onLine || (() => {});
    this.prompt = o.prompt || /(^|\n)[\w:~/-]*\$ ?$/;  // Zephyr's default prompt is "uart:~$ "
    this.port = null; this.writer = null; this.buf = ''; this.waiter = null; this.queue = Promise.resolve();
  }

  get open() { return !!this.port; }

  /** Opens the chooser (must run inside a click) and starts reading. */
  async connect(baudRate = 115200, serial = navigator.serial) {
    this.port = await serial.requestPort();
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.onLine(`Serial port open at ${baudRate} baud`, 'info');
    this.#readLoop();
  }

  async close() {
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); await this.port?.close(); } catch { /* already closed */ }
    this.port = null; this.writer = null;
    this.onLine('Serial port closed', 'info');
  }

  async #readLoop() {
    const dec = new TextDecoder();
    while (this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.#feed(dec.decode(value, { stream: true }));
        }
      } catch (e) { this.onLine(`Serial read stopped: ${e.message}`, 'info'); break; } finally { this.reader.releaseLock(); }
    }
  }

  #feed(text) {
    this.buf += text.replace(ANSI, '').replace(/\r/g, '');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      this.onLine(line, 'rx');
      this.waiter?.lines.push(line);
    }
    if (this.waiter && this.prompt.test(this.buf)) { const w = this.waiter; this.waiter = null; this.buf = ''; clearTimeout(w.timer); w.resolve(w.lines); }
  }

  /** Runs one shell command; resolves with the lines it printed (the echoed command removed). */
  run(cmd, timeoutMs = 3000) {
    const job = this.queue.then(() => new Promise((resolve, reject) => {
      if (!this.writer) { reject(new Error('Serial port not open')); return; }
      this.waiter = { lines: [], resolve: (lines) => resolve(lines.filter((l) => l.trim() && !l.trim().endsWith(cmd.trim()))), timer: setTimeout(() => { this.waiter = null; reject(new Error(`no prompt after "${cmd}" within ${timeoutMs / 1000} s`)); }, timeoutMs) };
      this.onLine(cmd, 'tx');
      this.writer.write(enc.encode(`${cmd}\r\n`)).catch(reject);
    }));
    this.queue = job.catch(() => {});
    return job;
  }
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** One register read through the i2c shell. */
export async function i2cRead(sh, bus, addr, reg) {
  const out = await sh.run(`i2c read_byte ${bus} ${hex2(addr)} ${hex2(reg)}`);
  const fail = out.find((l) => /Failed|not found|error/i.test(l));
  if (fail) throw new Error(fail.trim());
  const m = out.join('\n').match(/Output:\s*0x([0-9a-f]+)/i);
  if (!m) throw new Error(`unexpected reply: ${out.join(' | ') || '(nothing)'}`);
  return parseInt(m[1], 16);
}

/** One register write, read back to confirm. Returns the value the chip now holds. */
export async function i2cWrite(sh, bus, addr, reg, value) {
  if (!(value >= 0 && value <= 255)) throw new RangeError(`register value ${value} is not a byte`);
  const out = await sh.run(`i2c write_byte ${bus} ${hex2(addr)} ${hex2(reg)} ${hex2(value)}`);
  const fail = out.find((l) => /Failed|not found|error/i.test(l));
  if (fail) throw new Error(fail.trim());
  return i2cRead(sh, bus, addr, reg);
}
