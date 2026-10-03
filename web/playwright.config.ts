import { defineConfig, devices } from '@playwright/test';

// Set E2E_BASE_URL to test a server that is already running; otherwise Playwright starts the
// debug binary with a temporary data folder (`just e2e-server`).
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:18181';
const isCi = process.env.CI !== undefined;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  // One server and one password: the login throttle is global, so tests never run in parallel.
  workers: 1,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'on-first-retry', locale: 'en-US' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  ...(externalBaseUrl === undefined
    ? {
        webServer: {
          command: 'just e2e-server',
          cwd: '..',
          url: `${baseURL}/api/v1/health`,
          reuseExistingServer: !isCi,
          timeout: 300_000,
        },
      }
    : {}),
});
