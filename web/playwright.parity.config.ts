import { defineConfig } from '@playwright/test';

// The parity gate (`just parity <screen>`): the app on the frozen demo next to the mockup, as
// review sheets in PARITY_OUT_DIR (test-results/parity/<screen> by default). The servers are
// started once, on free ports, by e2e/parity/parityServers.setup.ts.
export default defineConfig({
  testDir: './e2e/parity',
  testMatch: '**/*.parity.ts',
  outputDir: 'test-results/parity-runs',
  globalSetup: './e2e/parity/parityServers.setup.ts',
  retries: 0,
  fullyParallel: true,
  workers: 2,
  timeout: 120_000,
  reporter: 'list',
});
