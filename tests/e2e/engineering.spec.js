// Engineering page end to end in sim mode: one simulated Polar sensor and one simulated SensWear board
// side by side, through the real links and the real capture worker. Known truth: the first Polar fake
// loses nothing, the first SensWear fake drops 0.2 % of samples at random (models.lossFor(1)); Polar mode is PPG 55 Hz and ACC 52 Hz; SensWear PPG is 200 Hz per colour and IMU
// 100 Hz, one sample per notification. Leaves tests/.out/engineering.png and engineering-plot.png to look at.
import { test, expect } from '@playwright/test';

const near = (v, want, tol) => expect(Math.abs(v - want) / want, `${v} against ${want}`).toBeLessThan(tol);

async function pick(page, kind, id) {
  await page.click(`[data-add="${kind}"]`);
  await page.click(`dialog [data-id="${id}"]`);
}

/** Each card's tables as { link, notif: {name: cells}, streams: {name: cells} }. */
const read = (page) => page.evaluate(() => [...document.querySelectorAll('.engx-slot')].map((s) => {
  const rows = (k) => Object.fromEntries([...s.querySelectorAll(`[data-k="${k}"] tr`)].map((r) => [...r.cells].map((c) => c.textContent.trim())).filter((c) => c.length > 2).map((c) => [c[0], c.slice(1)]));
  return { title: s.querySelector('h3').textContent, link: s.querySelector('[data-k="link"]').textContent, notif: rows('notif'), streams: rows('streams') };
}));

test('Polar and SensWear side by side: rates, packets, losses as the fakes make them', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/engineering.html?sim=1');
  await pick(page, 'polar', 'C8A1B2E4');
  await pick(page, 'senswear', '5E1A0C93');
  await expect(page.locator('.engx-slot')).toHaveCount(2);
  await expect(page.locator('[data-add="polar"]')).toBeVisible();
  await page.waitForTimeout(16000);   // the worker's rate windows need about 10 s of samples
  const [polar, sw] = await read(page);
  await page.screenshot({ path: 'tests/.out/engineering.png', fullPage: true });

  expect(polar.title).toContain('Polar'); expect(polar.link).toContain('streaming');
  near(Number(polar.streams.PPG[1]), 55, 0.03); near(Number(polar.streams.ACC[1]), 52, 0.03);
  expect(polar.streams.PPG[3]).toBe('0'); expect(polar.streams.PPG[4]).toBe('0');      // lost, gaps
  expect(Number(polar.notif.pmd[0])).toBeGreaterThan(1);                                 // PMD notifications per second

  expect(sw.title).toContain('SensWear'); expect(sw.link).toContain('streaming');
  near(Number(sw.streams.PPG[1]), 200, 0.03); near(Number(sw.streams.ACC[1]), 100, 0.03);
  const swLost = Number(sw.streams.PPG[3].split(' ')[0]);
  expect(swLost / 3000).toBeLessThan(0.01);                                              // about 0.2 % of ~3000 samples
  expect(Number(sw.streams.PPG[4]) > 0).toBe(swLost > 0);                                // every loss shows as a gap
  near(Number(sw.notif.ppg[0]), 200, 0.05); expect(sw.notif.ppg[1]).toBe('200');      // packets/s against expected

  // Filter: a corner above half the sample rate is refused with a reason, not drawn wrong.
  const card = page.locator('.engx-slot').first();
  await card.locator('.lanes').screenshot({ path: 'tests/.out/engineering-plot.png' });   // raw above, band-passed below
  await card.locator('[data-f="type"]').selectOption('low');
  await card.locator('[data-f="hi"]').fill('40');
  await card.locator('[data-f="hi"]').dispatchEvent('change');
  await expect(card.locator('[data-k="fwhy"]')).toContainText('Filter not applied');
  expect(errors).toEqual([]);
});
