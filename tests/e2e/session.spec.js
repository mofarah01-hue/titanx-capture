// End to end in sim mode, with an OPFS folder standing in for the Google Drive folder.
// The fake sensors run through the real connect steps, decoder, worker and recorder, and the
// finished zip is opened with Python's zipfile (an independent reader), not our own code.
// Each check below names the requirement it protects.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'tests/.out';
mkdirSync(OUT, { recursive: true });

// The stand in Drive folder lives in the browser's private storage and reaches the app through the
// test only ?testfolder= option.
async function seedFakeDrive(page, { shared = true, sim = 4 } = {}) {
  await page.goto(`/?sim=${sim}`);
  await page.evaluate(async (shared) => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['fake-drive', 'sessions']) { try { await root.removeEntry(n, { recursive: true }); } catch { /* absent */ } }
    const drive = await root.getDirectoryHandle('fake-drive', { create: true });
    if (shared) { const w = await (await drive.getFileHandle('sa7a_registry.json', { create: true })).createWritable(); await w.write('{"version":1,"athletes":[],"sensors":[]}'); await w.close(); }
    await new Promise((res, rej) => {
      const r = indexedDB.open('titanx-capture', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put({ done: true }, 'wizard'); t.oncomplete = () => { r.result.close(); res(); }; t.onerror = rej; };
      r.onerror = rej;
    });
  }, shared);
}

const listDrive = (page) => page.evaluate(async () => {
  const out = [];
  const walk = async (d, p) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, `${p}${n}/`); else out.push(`${p}${n}`); } };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('fake-drive'), '');
  return out;
});

async function extractFromDrive(page, path, into) {
  const b64 = await page.evaluate(async (path) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('fake-drive');
    const parts = path.split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const b = new Uint8Array(await (await (await d.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }, path);
  const zip = join(OUT, `${into}.zip`), dir = join(OUT, into);
  writeFileSync(zip, Buffer.from(b64, 'base64'));
  rmSync(dir, { recursive: true, force: true });
  execFileSync('python', ['-m', 'zipfile', '-t', zip]); // CRC and structure check by an independent reader
  execFileSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);
  const session = readdirSync(dir)[0];
  return join(dir, session);
}

function csv(path) {
  const [head, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

async function connectSim(page, id) {
  const card = page.locator(`article[data-id="${id}"]`);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: `Polar Sense ${id}` }).click();
  await expect(card.locator('[data-k="conn"]')).toHaveText(/^Connected/, { timeout: 40_000 });
}

async function startSession(page, label) {
  await page.getByRole('button', { name: 'Start a session' }).click();
  await page.locator('#label').fill(label);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
}

test('a sim session records every stream, logs gaps, and reaches the Drive folder', async ({ page }) => {
  await seedFakeDrive(page);
  await page.goto('/?sim=4&ckpt=15&testfolder=fake-drive');
  await startSession(page, 'e2e');
  const AMIR = 'C8A1B2E4', OMAR_BACK = 'C8A1F07D'; // Polar mode, lossless | Max rate mode, loses 2 % of packets
  await connectSim(page, AMIR);
  await connectSim(page, OMAR_BACK);

  await page.waitForTimeout(8000);
  await page.getByRole('button', { name: 'Heavy', exact: true }).click();
  await page.selectOption('#mTarget', { label: 'Amir Hassan' });
  await page.locator('#mNote').fill('strap tightened');
  await page.getByRole('button', { name: 'Adjusted', exact: true }).click();
  await page.selectOption('#mTarget', { value: 'all' });
  await page.waitForTimeout(32_000); // PPI starts about 25 s after connecting; a Drive copy runs every 15 s here
  await page.getByRole('button', { name: 'HR looks wrong', exact: true }).click();

  // Requirement: live view shows Polar HR as a plain number, Max rate mode shows it as off.
  await expect(page.locator(`article[data-id="${AMIR}"] [data-k="polar"]`)).toHaveText(/^\d{2,3}$/);
  await expect(page.locator(`article[data-id="${OMAR_BACK}"] [data-k="polar"]`)).toHaveText('Off');
  await page.screenshot({ path: `${OUT}/live-1470x956.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${OUT}/live-1280x800.png` });
  await page.setViewportSize({ width: 1470, height: 956 });

  // Requirement: most of a session reaches Drive while recording (part files in _live).
  expect((await listDrive(page)).some((p) => p.includes('/_live/') && p.endsWith('.csv'))).toBe(true);

  await page.locator(`article[data-id="${AMIR}"] .ap-name`).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/monitor.png` });
  await page.getByRole('button', { name: 'All athletes' }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/timeline.png` });
  await page.getByRole('button', { name: 'Live', exact: true }).click();

  await page.locator('#bEnd').click();
  await page.locator('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('SESSION ENDED')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Saved to Google Drive folder fake-drive/)).toBeVisible();
  await page.screenshot({ path: `${OUT}/end.png` });

  const files = await listDrive(page);
  const zipPath = files.find((f) => f.endsWith('.zip'));
  expect(zipPath).toBeTruthy();
  // Requirement: part files are removed only after the zip is in place.
  expect(files.some((f) => f.includes('/_live/'))).toBe(false);
  const dir = await extractFromDrive(page, zipPath, 'session');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const ann = JSON.parse(readFileSync(join(dir, 'annotations.json'), 'utf8'));

  // Requirement: one file per stream per device, named <deviceId>_<athlete>_<stream>.csv.
  const f = (id, who, s) => join(dir, `${id}_${who}_${s}.csv`);
  for (const s of ['ppg', 'acc', 'gyro', 'mag', 'frames', 'hr', 'ppi']) expect(existsSync(f(AMIR, 'Amir-Hassan', s)), s).toBe(true);
  for (const s of ['ppg', 'acc', 'gyro', 'mag', 'frames']) expect(existsSync(f(OMAR_BACK, 'Omar-Nasser', s)), s).toBe(true);
  expect(existsSync(f(OMAR_BACK, 'Omar-Nasser', 'ppi')), 'no PPI in Max rate mode').toBe(false);

  // Requirement: measured rates are recorded, and match what the sensor was asked for (sim truth).
  for (const d of manifest.devices) {
    for (const k of ['ppg', 'acc', 'gyro', 'mag']) {
      const st = d.streams[k], set = st.requested.sampleRate;
      expect(Math.abs(st.measured_hz - set) / set, `${d.device_id} ${k} measured ${st.measured_hz} vs ${set}`).toBeLessThan(0.02);
    }
  }
  const omar = manifest.devices.find((d) => d.device_id === OMAR_BACK);
  expect(omar.streams.ppg.requested.sampleRate, 'Max rate mode asks for the highest PPG rate').toBe(176);

  // Requirement: never interpolate across a gap. No sample is ever closer than half a period to the
  // previous one; the lossy sensor has real holes, and they are listed in the manifest.
  for (const [id, who, fs, lossy] of [[AMIR, 'Amir-Hassan', 55, false], [OMAR_BACK, 'Omar-Nasser', 176, true]]) {
    const rows = csv(f(id, who, 'ppg'));
    const ts = rows.map((r) => BigInt(r.t_sensor_ns));
    let holes = 0;
    for (let i = 1; i < ts.length; i++) {
      const dt = Number(ts[i] - ts[i - 1]) / 1e9;
      expect(dt, `${id} sample ${i}`).toBeGreaterThan(0.5 / fs);
      if (dt > 1.5 / fs) holes++;
    }
    const span = Number(ts.at(-1) - ts[0]) / 1e9, lost = manifest.devices.find((d) => d.device_id === id).streams.ppg.lost_samples_est;
    expect(Math.abs(rows.length + lost - (span * fs + 1)) / (span * fs), `${id} rows + lost vs span`).toBeLessThan(0.01);
    if (lossy) { expect(holes).toBeGreaterThan(0); expect(manifest.dropouts.filter((g) => g.device_id === id && g.kind === 'packets').length).toBeGreaterThan(0); }
    else expect(holes).toBe(0);
  }

  // Requirement: marks record time, label, text, target, and the sample index of every targeted stream.
  expect(ann.map((a) => a.label)).toEqual(['Heavy', 'Adjusted', 'HR looks wrong']);
  const heavy = ann[0], adjusted = ann[1];
  expect(Object.keys(heavy.newest_sample_index)).toEqual(expect.arrayContaining([`${AMIR}.ppg`, `${OMAR_BACK}.ppg`]));
  expect(adjusted.text).toBe('strap tightened');
  expect(Object.keys(adjusted.newest_sample_index).every((k) => k.startsWith(AMIR))).toBe(true);
  for (const m of ann) {
    for (const [id, who] of [[AMIR, 'Amir-Hassan'], [OMAR_BACK, 'Omar-Nasser']]) {
      const idx = m.newest_sample_index[`${id}.ppg`]; if (idx == null) continue;
      const row = csv(f(id, who, 'ppg'))[idx];
      expect(Number(row.i)).toBe(idx);
      const t = Number(row.t_session_s);
      expect(t, `${m.label} ${id}: newest sample not after the press`).toBeLessThanOrEqual(m.t_session_s + 0.05);
      expect(t, `${m.label} ${id}: newest sample within 2.5 s before the press`).toBeGreaterThan(m.t_session_s - 2.5);
    }
  }

  // Requirement: Polar HR and PPI are recorded in Polar mode.
  const hr = csv(f(AMIR, 'Amir-Hassan', 'hr'));
  expect(hr.length).toBeGreaterThan(30);
  expect(hr.every((r) => +r.hr_bpm >= 40 && +r.hr_bpm <= 220)).toBe(true);
  const ppi = csv(f(AMIR, 'Amir-Hassan', 'ppi'));
  expect(ppi.length).toBeGreaterThan(5);
  expect(ppi.every((r) => +r.pp_ms >= 250 && +r.pp_ms <= 2000)).toBe(true);
});

test('a session the app never ended is recovered into the Drive folder on the next launch', async ({ page }) => {
  await seedFakeDrive(page, { sim: 2 });
  await page.goto('/?sim=2&testfolder=fake-drive');
  await startSession(page, 'crash');
  await connectSim(page, 'C8A1B2E4');
  await page.waitForTimeout(12_000);
  await page.reload(); // the tab dies mid session: nothing is finalised
  await expect.poll(async () => (await listDrive(page)).find((f) => f.endsWith('.zip') && f.includes('crash')), { timeout: 30_000 }).toBeTruthy();
  const zipPath = (await listDrive(page)).find((f) => f.endsWith('.zip') && f.includes('crash'));
  const dir = await extractFromDrive(page, zipPath, 'recovered');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  expect(manifest.recovered).toBeTruthy();
  const rows = csv(join(dir, 'C8A1B2E4_Amir-Hassan_ppg.csv'));
  expect(rows.length, 'rows saved up to about a second before the tab died').toBeGreaterThan(8 * 55);
});

test('a save folder that is not the shared Sa7a folder is flagged, not blocked', async ({ page }) => {
  await seedFakeDrive(page, { shared: false, sim: 1 });
  await page.goto('/?sim=1&testfolder=fake-drive');
  await expect(page.locator('#storeTxt')).toHaveText('This Mac only');
  await startSession(page, 'local');
  await expect(page.getByText(/Recordings will not reach Mohammad/)).toBeVisible();
});
