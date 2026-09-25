// The zip is read on a Mac by Archive Utility and on Windows by Explorer, never by our own code,
// so every check here goes through independent readers: Python's zipfile (verifies CRCs) and
// libarchive's bsdtar (extracts). If either is missing the test is skipped, not passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip, crc32 } from '../../core/storage/zip.js';

const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
const has = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const PY = has('python', ['--version']) ? 'python' : has('python3', ['--version']) ? 'python3' : null;
const TAR = has(tar, ['--version']) ? tar : null;

// Catches: wrong CRC table or signedness (every archive tool rejects the file).
test('crc32 matches the published check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

const csvBytes = new TextEncoder().encode('i,t_session_s,ppg0\n' + Array.from({ length: 20000 }, (_, i) => `${i},${(i / 55).toFixed(4)},${(Math.sin(i) * 1e5) | 0}`).join('\n') + '\n');
const random = new Uint8Array(70000); for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) >>> 24;
const EXPECT = {
  'sa7a_2026-09-25_1810_test/C8A1B2E4_Omar_ppg.csv': csvBytes,
  'sa7a_2026-09-25_1810_test/empty.csv': new Uint8Array(0),
  'sa7a_2026-09-25_1810_test/C8A1B2E4_عمر_hr.csv': new TextEncoder().encode('i,hr\n0,61\n'),
  'sa7a_2026-09-25_1810_test/raw.bin': random,
};
// Fresh sources per archive (a stream can be read once). The CSV arrives in 4 KiB chunks so the
// CRC has to chain across chunks; the others cover Blob, string and empty input.
function entries(names) {
  return names.map((name) => {
    const b = EXPECT[name];
    if (name.endsWith('_ppg.csv')) return { name, source: new ReadableStream({ start(c) { for (let i = 0; i < b.length; i += 4096) c.enqueue(b.subarray(i, i + 4096)); c.close(); } }) };
    if (name.endsWith('.bin')) return { name, source: new Blob([b]) };
    if (name.endsWith('_hr.csv')) return { name, source: new TextDecoder().decode(b) };
    return { name, source: b };
  });
}
async function zipFile(dir, file, names) {
  const parts = [];
  const res = await writeZip(entries(names), { write: (b) => { parts.push(Buffer.from(b)); } });
  const buf = Buffer.concat(parts);
  assert.equal(buf.length, res.bytes);
  writeFileSync(join(dir, file), buf);
  return join(dir, file);
}

// Catches: wrong local header offsets, data descriptor sizes not matching the central directory,
// CRC not chained across chunks, empty entries, UTF-8 names without the UTF-8 flag.
test('archive opens in independent readers with identical bytes', { skip: !PY || !TAR ? 'python or bsdtar missing' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-zip-'));
  const all = Object.keys(EXPECT);

  const full = await zipFile(dir, 'full.zip', all);
  execFileSync(PY, ['-m', 'zipfile', '-t', full], { stdio: 'pipe' }); // throws on any CRC or structure error
  const px = join(dir, 'py');
  execFileSync(PY, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); open(sys.argv[3],"w",encoding="utf-8").write("\\n".join(z.namelist()))', full, px, join(dir, 'names.txt')]);
  assert.deepEqual(readFileSync(join(dir, 'names.txt'), 'utf8').split(/\r?\n/), all);
  for (const n of all) assert.deepEqual(readFileSync(join(px, n)), Buffer.from(EXPECT[n]), n);

  // Windows bsdtar cannot map non ASCII names to its console code page and aborts, so the second
  // reader gets an ASCII only archive. Python above already covered the UTF-8 name.
  const ascii = all.filter((n) => /^[\x20-\x7e]+$/.test(n));
  const small = await zipFile(dir, 'ascii.zip', ascii);
  const tx = join(dir, 'tar'); mkdirSync(tx);
  execFileSync(TAR, ['-xf', small, '-C', tx]);
  for (const n of ascii) assert.deepEqual(readFileSync(join(tx, n)), Buffer.from(EXPECT[n]), n);
});
