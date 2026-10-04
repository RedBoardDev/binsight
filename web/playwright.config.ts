import { defineConfig, devices } from '@playwright/test';

// Every test starts its own server on a fresh data folder (e2e/fixtures.ts), from the debug
// binary `just e2e` builds; nothing is shared between tests, so they may run in parallel. Set
// E2E_BASE_URL to test a server that is already running instead.
const isCi = process.env.CI !== undefined;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: isCi,
  retries: 0,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: process.env.E2E_BASE_URL, trace: 'retain-on-failure', locale: 'en-US' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
