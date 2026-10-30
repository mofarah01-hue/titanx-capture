// core/runs.js against a fake directory tree (OPFS does not exist in Node). Fake data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipToBlob } from '../../core/storage/zip.js';
import { parseCsv, openZip, listRuns, loadRun } from '../../core/runs.js';

// A tree is { name: string | Uint8Array | Blob | { ...subtree } }. Missing names throw NotFoundError like a real handle.
const nf = (n) => Object.assign(new Error(`${n} not found`), { name: 'NotFoundError' });
const isDir = (v) => v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof Blob);
function dir(tree) {
  const wrap = (k, v) => (isDir(v) ? dir(v) : { kind: 'file', name: k, getFile: async () => new File([v], k) });
  return {
    kind: 'directory',
    async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, wrap(k, v)]; },
    async getFileHandle(n) { if (!(n in tree) || isDir(tree[n])) throw nf(n); return wrap(n, tree[n]); },
    async getDirectoryHandle(n) { if (!(n in tree) || !isDir(tree[n])) throw nf(n); return dir(tree[n]); },
  };
}

const H4 = 'i,t_session_s,t_sensor_ns,ppg0,ppg1,ppg2,ambient\n';
const ppgRows = (a, b, mark = 0) => Array.from({ length: b - a }, (_, k) => `${a + k},${((a + k) / 55).toFixed(4)},${1e9 + k},${100 + mark},${200 + mark},${300 + mark},${9 + mark}\n`).join('');

// Catches: one bad line throwing away the file, a bad line shifting later columns, an empty cell read as 0
// (a flat line in the PPG), CRLF text leaking "\r" into the last column, and a cut-off last line whose last
// number is short but still parses.
test('parseCsv: bad lines and empty cells are counted and left out, nothing else moves', () => {
  const text = H4
    + '0,0.0000,1,100,200,300,9\r\n'
    + '1,0.0182,2,101,,301,9\r\n'            // empty cell: a gap
    + '2,0.0364,3,garbage,202,302,9\r\n'    // not a number
    + '3,0.0545,4,103,203\r\n'              // short line
    + '4,0.0727,5,104,204,304,12\r\n'
    + '\r\n'                                 // blank line is nothing, not bad
    + '5,0.0909,6,105,205,305,1';            // cut off: no newline
  const p = parseCsv(text);
  assert.deepEqual([p.rows, p.bad, p.gaps, p.ch], [2, 3, 1, 4]);
  assert.deepEqual([...p.t], [0, 0.0727]);
  assert.deepEqual([...p.v], [100, 200, 300, 9, 104, 204, 304, 12]);
  assert.deepEqual(p.cols, ['ppg0', 'ppg1', 'ppg2', 'ambient']);
});

// Catches: reading the Polar HR file's rr_ms column (empty on most rows) as signal, so every row became a gap.
test('parseCsv: only the asked-for columns decide whether a row is a gap', () => {
  const p = parseCsv('i,t_session_s,hr_bpm,sensor_contact,rr_ms\n0,1.0000,61,1,\n1,2.0000,62,1,950;940\n', { cols: ['hr_bpm'] });
  assert.deepEqual([p.rows, p.gaps, p.bad, [...p.v]], [2, 0, 0, [61, 62]]);
});

// Catches: a zip reader that works only on its own fixtures. The bytes go through the real writer (deflate).
test('zip: whole entries come back byte for byte, and damage throws', async () => {
  const csv = new TextEncoder().encode(H4 + ppgRows(0, 5000));
  const bin = new Uint8Array(70000).map((_, i) => (i * 2654435761) >>> 24);
  const blob = await zipToBlob([{ name: 's/a_ppg.csv', source: csv }, { name: 's/empty.csv', source: new Uint8Array(0) }, { name: 's/raw.bin', source: new Blob([bin]) }]);
  const z = await openZip(blob);
  assert.deepEqual(z.entries.map((e) => e.name), ['s/a_ppg.csv', 's/empty.csv', 's/raw.bin']);
  assert.deepEqual(await z.read('s/a_ppg.csv'), csv);
  assert.deepEqual(await z.read('s/raw.bin'), bin);
  assert.equal((await z.read('s/empty.csv')).length, 0);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  bytes[z.entries[2].offset + 60] ^= 0xFF;              // inside the deflate data of raw.bin
  await assert.rejects(async () => (await openZip(new Blob([bytes]))).read('s/raw.bin'));
  await assert.rejects(() => openZip(new Blob([bytes.subarray(0, bytes.length - 40)])), /zip/);   // cut short: no end record
});

const manifestOf = (name, devices, extra = {}) => ({ format: 'titanx-capture/1', session: { name, label: name.split('_').pop(), started: extra.started || '2026-10-20T15:00:00.000Z', duration_s: extra.duration_s ?? 100 }, devices, dropouts: extra.dropouts || [], marks: 0 });
const polarDev = (id, athlete, files, extra = {}) => ({ device_id: id, kind: 'polar', athlete, athlete_id: extra.athlete_id ?? `ath-${athlete}`, mode: 'max', streams: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { file: f, samples: 10, measured_hz: 55 }])) });

// Catches: part files joined in directory order (here: 3, 1, 2) which puts rows out of order and the header
// in the middle; a part that ends in the middle of a line; a missing part passing silently.
test('parts of a split file are joined in numeric order, mid-line splits included', async () => {
  const full = H4 + ppgRows(0, 30), cut1 = 100, cut2 = 400;       // cuts land inside lines
  const parts = { 'a_ppg.part0003.csv': full.slice(cut2), 'a_ppg.part0001.csv': full.slice(0, cut1), 'a_ppg.part0002.csv': full.slice(cut1, cut2) };
  const m = manifestOf('sa7a_x_live', [polarDev('A', 'Omar', { ppg: 'a_ppg.csv' })]);
  const run = (await listRuns({ folder: dir({ sa7a_x_live: { 'manifest.json': JSON.stringify(m), _live: parts } }) }))[0];
  assert.equal(run.finished, false);
  const d = await loadRun(run, 'A');
  assert.deepEqual([d.streams.ppg.t.length, d.stats.ppg.bad, d.stats.ppg.gaps], [30, 0, 0]);
  assert.ok(d.streams.ppg.t.every((t, i, a) => !i || t > a[i - 1]), 'time runs forwards');
  delete parts['a_ppg.part0002.csv'];
  const holes = await loadRun((await listRuns({ folder: dir({ sa7a_x_live: { 'manifest.json': JSON.stringify(m), _live: parts } }) }))[0], 'A');
  assert.match(holes.warnings.join('\n'), /missing/);
});

// Catches: taking the first device's files for every device, a Polar athlete's HR landing on the SensWear board,
// a mark meant for another athlete showing up, and the file named in the manifest being only the newest one
// (a layout change mid run starts `..._ppg_2`; the first half of the run would be lost without a word).
test('two devices: each gets its own files, marks and dropouts; a layout change joins both files', async () => {
  const swCsv = (v) => 'i,t_session_s,t_sensor_ms,rx_session_s,counts\n' + [0, 1, 2, 3].map((i) => `${i},${i * 0.005},${i * 5},${i * 0.005},${v + i}\n`).join('');
  const accCsv = 'i,t_session_s,t_sensor_ns,x_mg,y_mg,z_mg\n0,0.0000,1,1,2,1000\n1,0.0192,2,2,3,1001\n';
  const m = manifestOf('sa7a_two', [
    polarDev('A', 'Omar', { ppg: 'A_Omar_ppg_2.csv', acc: 'A_Omar_acc.csv', hr: 'A_Omar_hr.csv' }),
    { device_id: 'B', kind: 'senswear', athlete: 'Sam', athlete_id: 'ath-Sam', streams: { ppg: { file: 'B_Sam_ppg_green.csv' }, ppg_red: { file: 'B_Sam_ppg_red.csv' }, ppg_ir: { file: 'B_Sam_ppg_ir.csv' }, quat: { file: 'B_Sam_quat.csv' } } },
  ], { dropouts: [{ device_id: 'A', stream: 'ppg', kind: 'packets', at_session_s: 12.5, missing_samples_est: 9 }, { device_id: 'B', stream: null, kind: 'link', from_session_s: 20, to_session_s: 24, duration_s: 4 }] });
  const ann = [{ t_session_s: 5, label: 'heavy', text: 'bag', target: 'all' }, { t_session_s: 6, label: 'adjusted', text: 'A only', target: 'ath-Omar' }, { t_session_s: 7, label: 'adjusted', text: 'B only', target: 'ath-Sam' }];
  const tree = {
    sa7a_two: {
      'manifest.json': JSON.stringify(m), 'annotations.json': JSON.stringify(ann), 'state.json': JSON.stringify({ finalized: true }),
      'A_Omar_ppg.csv': H4 + ppgRows(0, 20, 0), 'A_Omar_ppg_2.csv': H4 + ppgRows(20, 30, 0), 'A_Omar_acc.csv': accCsv,
      'A_Omar_hr.csv': 'i,t_session_s,hr_bpm,sensor_contact,rr_ms\n0,1.0000,61,1,\n1,2.0000,62,1,\n',
      'B_Sam_ppg_green.csv': swCsv(1000), 'B_Sam_ppg_red.csv': swCsv(2000), 'B_Sam_ppg_ir.csv': swCsv(3000), 'B_Sam_quat.csv': 'garbage\n',
    },
  };
  const runs = await listRuns({ opfs: dir(tree) });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].devices.map((d) => [d.id, d.kind, d.athlete]), [['A', 'polar', 'Omar'], ['B', 'senswear', 'Sam']]);
  const A = await loadRun(runs[0], 'A'), B = await loadRun(runs[0], 'B');
  assert.equal(A.streams.ppg.t.length, 30, 'both ppg files');
  assert.equal(A.streams.ppg.ch, 4);
  assert.deepEqual([...A.polarHr.v], [61, 62]);
  assert.deepEqual(Object.keys(A.streams).sort(), ['acc', 'ppg']);
  assert.deepEqual(Object.keys(B.streams).sort(), ['ppg', 'ppg_ir', 'ppg_red']);
  assert.equal(B.polarHr, null);
  assert.deepEqual([B.streams.ppg.v[0], B.streams.ppg_red.v[0], B.streams.ppg_ir.v[0], B.streams.ppg.ch], [1000, 2000, 3000, 1]);
  assert.deepEqual(A.marks.map((x) => x.text), ['bag', 'A only']);
  assert.deepEqual(B.marks.map((x) => x.text), ['bag', 'B only']);
  assert.deepEqual(A.dropouts.map((d) => [d.t, d.to]), [[12.5, null]]);
  assert.deepEqual(B.dropouts.map((d) => [d.t, d.to]), [[20, 24]]);
  await assert.rejects(() => loadRun(runs[0], 'Z'), /not in run/);
});

// End to end on a finished folder run: the list, the zip, the parse, in the shape the Past runs view uses.
// Catches: newest first broken, a folder without a manifest listed as a run, the same run listed twice,
// the zip entry path (`<name>/<file>`) not matching the manifest's bare file name.
test('listRuns + loadRun over a zipped folder run, ordering and duplicates', async () => {
  const name = 'sa7a_2026-10-21_0900_zipped', csv = H4 + ppgRows(0, 600);
  const m = manifestOf(name, [polarDev('A', 'Omar', { ppg: 'A_Omar_ppg.csv' })], { started: '2026-10-21T16:00:00.000Z', duration_s: 11 });
  const zip = await zipToBlob([{ name: `${name}/A_Omar_ppg.csv`, source: new TextEncoder().encode(csv) }, { name: `${name}/manifest.json`, source: JSON.stringify(m) }]);
  const older = manifestOf('sa7a_old', [polarDev('A', 'Omar', { ppg: 'A_Omar_ppg.csv' })], { started: '2026-10-19T16:00:00.000Z' });
  const folder = dir({ [name]: { [`${name}.zip`]: zip, 'manifest.json': JSON.stringify(m), 'annotations.json': '[]' }, notes: { 'readme.txt': 'x' }, sa7a_dup: { 'manifest.json': JSON.stringify(manifestOf('sa7a_dup', [])) } });
  const opfs = dir({ sa7a_old: { 'manifest.json': JSON.stringify(older), 'state.json': '{"finalized":true}', 'A_Omar_ppg.csv': csv.slice(0, 200) }, sa7a_dup: { 'manifest.json': JSON.stringify(manifestOf('sa7a_dup', [])) } });
  const runs = await listRuns({ opfs, folder });
  assert.deepEqual(runs.map((r) => [r.name, r.source, r.finished]), [[name, 'folder', true], ['sa7a_dup', 'device', false], ['sa7a_old', 'device', true]]);
  assert.equal(runs[1].also, 'folder');
  assert.deepEqual([runs[0].label, runs[0].durationS, runs[0].started], ['zipped', 11, '2026-10-21T16:00:00.000Z']);
  const d = await loadRun(runs[0], 'A');
  assert.equal(d.streams.ppg.t.length, 600);
  assert.equal(d.streams.ppg.v.length, 2400);
  assert.deepEqual(d.warnings, []);
  assert.equal(runs.errors.length, 0);
});

// Catches: a broken manifest hiding every other run, and the error vanishing instead of reaching the list.
test('listRuns: one unreadable manifest is reported, the others still list', async () => {
  const good = manifestOf('sa7a_good', []);
  const runs = await listRuns({ opfs: dir({ sa7a_bad: { 'manifest.json': '{oops' }, sa7a_good: { 'manifest.json': JSON.stringify(good) } }) });
  assert.deepEqual(runs.map((r) => r.name), ['sa7a_good']);
  assert.match(runs.errors[0], /sa7a_bad.*not valid JSON/);
});
