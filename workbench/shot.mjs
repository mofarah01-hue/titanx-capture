// Screenshot of the workbench with one session loaded, for checking the GUI by eye.
//   node workbench/shot.mjs [URL] [OUT.png] [session id]
// Uses the installed Google Chrome through the repo's Playwright devDependency (no browser download).
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://127.0.0.1:8795/';
const out = process.argv[3] || new URL('./screenshot.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sid = process.argv[4];
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(sid ? `${url}?session=${encodeURIComponent(sid)}` : url);
if (!sid) await page.locator('#sessions li').first().click();
// wait until every lane card has run (or failed) and the table is drawn
await page.waitForFunction(() => [...document.querySelectorAll('.card .foot span')].every((s) => !/running|not run/.test(s.textContent)) && document.querySelector('#table table'), null, { timeout: 600_000 });
const done = () => page.waitForFunction(() => [...document.querySelectorAll('.card .foot span')].every((s) => !/running|not run/.test(s.textContent)) && document.querySelector('#table table'), null, { timeout: 600_000 });
if (process.env.SHOT_MODELS) {   // also add a model lane (the first installed model) and run everything again
  await page.click('#add-model');
  await page.click('#run-all');
  await page.waitForTimeout(500);
  await done();
}
await page.waitForTimeout(1500);
await page.screenshot({ path: out, fullPage: true });
const cards = await page.locator('.card .foot span').allTextContents();
console.log(JSON.stringify({ out, cards, errors }));
await browser.close();
if (errors.length) process.exit(1);
