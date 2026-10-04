import { defineConfig, devices } from '@playwright/test';

// Screenshots for review (not pixel baselines): the shell and the design reference, on a desktop
// and a phone, in both themes. The Vite dev server (the reference page exists in development only)
// talks to a stub API, so no binary is needed. Shots land in test-results/visual/.
const STUB_API_PORT = 8099;
const DEV_SERVER_PORT = 5174;
const isCi = process.env.CI !== undefined;

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
// The iPhone 14 profile's viewport leaves out Safari's bars; the review uses the full screen.
const phone = {
  ...devices['iPhone 14'],
  viewport: { width: 390, height: 844 },
  defaultBrowserType: 'chromium' as const,
};

export default defineConfig({
  testDir: './e2e/visual',
  testMatch: '**/*.visual.ts',
  outputDir: 'test-results/visual-runs',
  forbidOnly: isCi,
  retries: 0,
  // The host shares its cores with production and other builds: a screen with axe on it can take
  // far longer than Playwright's defaults there. Deadlines, not retries.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: isCi ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${DEV_SERVER_PORT}`,
    locale: 'en-US',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { ...phone, colorScheme: 'dark' } },
    { name: 'mobile-light', use: { ...phone, colorScheme: 'light' } },
  ],
  webServer: [
    {
      command: 'node e2e/visual/stubApiServer.ts',
      env: { STUB_API_PORT: String(STUB_API_PORT) },
      port: STUB_API_PORT,
      reuseExistingServer: !isCi,
    },
    {
      command: `vite --port ${DEV_SERVER_PORT} --strictPort`,
      env: { BINSIGHT_DEV_API_URL: `http://127.0.0.1:${STUB_API_PORT}` },
      port: DEV_SERVER_PORT,
      reuseExistingServer: !isCi,
    },
  ],
});
