// Pitch screenshots of the live view with simulated athletes. Needs the dev server running:
//   npm run serve   then   node tools/shots.mjs [outDir]
// Each shot runs the one click demo in pitch mode (?pitch=1: no development chrome, illustrative
// Titan X HR), starts the Aerobic base plan at its zone 3 phase, waits 45 s so beat to
// beat data and zones fill in, and saves a 2x PNG.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] || 'tests/.out/pitch';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
for (const n of [2, 10]) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  // A stand in "Sa7a" folder in the browser's private storage, with the athlete list in it, so the
  // header shows saving as it would with the real shared folder.
  await page.goto(`http://localhost:8080/?sim=${n}`);
  await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Sa7a', { create: true });
    const w = await (await d.getFileHandle('sa7a_registry.json', { create: true })).createWritable();
    await w.write('{"version":1,"athletes":[],"sensors":[]}'); await w.close();
  });
  await page.goto(`http://localhost:8080/?sim=${n}&pitch=1&testfolder=Sa7a`);
  await page.getByRole('button', { name: 'Run the demo' }).click();
  // Aerobic base in its zone 3 phase: athletes above, in and below zone 3 show all three colours.
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.locator('.plancard[data-id="aerobic"]').click();
  await page.getByRole('button', { name: 'Start this plan' }).click();
  await page.getByRole('button', { name: 'Next phase' }).click();
  await page.waitForTimeout(45_000);
  await page.mouse.move(2, 1070); // no hover highlight on a tile
  await page.waitForTimeout(600);
  const file = `${out}/titanx-live-${n}-athletes.png`;
  await page.screenshot({ path: file });
  console.log('saved', file);
  await page.close();
}
await browser.close();
