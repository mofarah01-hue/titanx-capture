// End to end tests in sim mode, in the installed Google Chrome (no browser download needed).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'tests/.out/playwright',
  use: {
    baseURL: 'http://localhost:8090',
    channel: 'chrome',
    viewport: { width: 1470, height: 956 },
    screenshot: 'only-on-failure',
  },
  webServer: { command: 'node tools/serve.mjs 8090', url: 'http://localhost:8090', reuseExistingServer: true },
});
