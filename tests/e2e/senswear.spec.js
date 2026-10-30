// SensWear GUI end to end in sim mode: the fake board (core/sim/fake-senswear.js) runs through the real
// SensWear link, worker and recorder, and the zip is opened with Python's zipfile, as in session.spec.js.
// The fake board's truth is known: PPG at 200 samples per second per colour, IMU at 100 Hz, gravity of 1 g,
// a clock that starts at 2026-01-01, and the stock firmware's MAX30101 registers.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'tests/.out';
mkdirSync(OUT, { recursive: true });

async function seedFakeDrive(page) {
  await page.goto('/senswear.html?sim=1');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['fake-drive', 'sessions']) { try { await root.removeEntry(n, { recursive: true }); } catch { /* absent */ } }
    const drive = await root.getDirectoryHandle('fake-drive', { create: true });
    const w = await (await drive.getFileHandle('sa7a_registry.json', { create: true })).createWritable(); await w.write('{"version":1,"athletes":[],"sensors":[]}'); await w.close();
  });
}
async function zipFromDrive(page, into) {
  const b64 = await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('fake-drive');
    let zip = null;
    const walk = async (h) => { for await (const [n, x] of h.entries()) { if (x.kind === 'directory') await walk(x); else if (n.endsWith('.zip')) zip = x; } };
    await walk(d);
    const b = new Uint8Array(await (await zip.getFile()).arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const zip = join(OUT, `${into}.zip`), dir = join(OUT, into);
  writeFileSync(zip, Buffer.from(b64, 'base64'));
  rmSync(dir, { recursive: true, force: true });
  execFileSync('python', ['-m', 'zipfile', '-t', zip]);
  execFileSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);
  return join(dir, readdirSync(dir)[0]);
}
function csv(path) {
  const [head, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

test('SensWear sim: connect, record every stream at the true rates, log gaps, edit a PPG register', async ({ page }) => {
  await seedFakeDrive(page);
  await page.goto('/senswear.html?sim=1&ckpt=15&testfolder=fake-drive');
  await page.getByRole('button', { name: 'Start a session' }).click();
  await page.locator('#label').fill('sw-e2e');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const card = page.locator('article[data-id="5E1A0C93"]');
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Sens Wear (OOB)' }).click();
  await expect(card.locator('[data-k="conn"]')).toHaveText(/^Connected/, { timeout: 30_000 });

  // Requirement: SensWear has no heart rate of its own, and the page says so instead of showing a number.
  await expect(card.locator('[data-k="polar"]')).toHaveText('None');
  await page.waitForTimeout(20_000);
  await page.screenshot({ path: `${OUT}/sw-live.png` });

  // Requirement: the engineering view reads and writes the PPG chip's registers through the debug board's shell.
  await page.getByRole('button', { name: 'Engineering', exact: true }).click();
  await page.getByRole('button', { name: 'Device', exact: true }).click();   // Engineering opens on HR lab; the board is on Device
  await expect(page.locator('[data-k="board"]')).toContainText('board clock was 2026-01-01'); // clock fixed on connect
  await page.getByRole('button', { name: 'Connect the simulated debug board' }).click();
  await page.getByRole('button', { name: 'Read all' }).click();
  await expect(page.locator('[data-k="regmsg"]')).toContainText('Read 21 registers', { timeout: 10_000 });
  const led3 = page.locator('tr[data-reg="14"]');
  await expect(led3.locator('[data-k="v"]')).toHaveText('0x03');           // stock firmware: 0.6 mA green
  await led3.locator('[data-f="LED3_PA"]').fill('1.2');
  await led3.locator('[data-w="14"]').click();
  await expect(led3.locator('[data-k="v"]')).toHaveText('0x06');           // 1.2 mA, read back from the chip
  await expect(page.locator('[data-k="ratecheck"]')).toContainText('Not allowed'); // 3200 sps, 3 LEDs, 215 µs
  await page.screenshot({ path: `${OUT}/sw-engineering.png`, fullPage: true });
  await page.getByRole('button', { name: 'Titan X', exact: true }).click();   // back to the coach mode; the sensor stays connected
  await page.getByRole('button', { name: 'Live', exact: true }).click();

  await page.locator('#bEnd').click();
  await page.locator('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('SESSION ENDED')).toBeVisible({ timeout: 30_000 });
  const dir = await zipFromDrive(page, 'sw-session');
  const files = readdirSync(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const dev = manifest.devices[0];

  // Requirement: every stream the board sends is recorded, under the SensWear kind.
  expect(dev.kind).toBe('senswear');
  for (const s of ['ppg_green', 'ppg_red', 'ppg_ir', 'acc', 'gyro', 'quat', 'temperature']) expect(files.some((f) => f.endsWith(`_${s}.csv`)), s).toBe(true);

  // Requirement: the recorded rate is the true one (200 per colour, 100 IMU) and lost samples are logged, never filled in.
  const green = csv(join(dir, files.find((f) => f.endsWith('_ppg_green.csv'))));
  const span = Number(green.at(-1).t_session_s) - Number(green[0].t_session_s);
  const lostGreen = manifest.dropouts.filter((g) => g.stream === 'ppg').reduce((a, g) => a + g.missing_samples_est, 0);
  expect(Math.abs((green.length + lostGreen) / span - 200) / 200).toBeLessThan(0.02);
  let jumps = 0;
  for (let i = 1; i < green.length; i++) {
    const dt = Number(green[i].t_sensor_ms) - Number(green[i - 1].t_sensor_ms);
    expect(dt, `row ${i}`).toBeGreaterThan(0);                 // board time only moves forward
    if (dt > 7.5) jumps += Math.round(dt / 5) - 1;             // samples missing between these two rows
    expect(Number(green[i].t_session_s)).toBeGreaterThan(Number(green[i - 1].t_session_s));
  }
  expect(jumps).toBe(lostGreen);                                // every gap in the file is in the manifest, and no more
  const acc = csv(join(dir, files.find((f) => f.endsWith('_acc.csv'))));
  const accSpan = Number(acc.at(-1).t_session_s) - Number(acc[0].t_session_s);
  expect(Math.abs(acc.length / accSpan - 100) / 100).toBeLessThan(0.03);

  // Requirement: ACC is in mg with gravity included, so a head at rest reads about 1000 mg.
  const mags = acc.map((r) => Math.hypot(+r.x_mg, +r.y_mg, +r.z_mg)).sort((a, b) => a - b);
  expect(mags[mags.length >> 1]).toBeGreaterThan(800);
  expect(mags[mags.length >> 1]).toBeLessThan(1200);
});
