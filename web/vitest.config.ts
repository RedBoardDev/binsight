import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Run west of UTC, where a UTC day bucket formatted in local time lands on the previous day — so the
// day-formatting tests prove the fix instead of passing by accident on a UTC machine.
process.env.TZ = 'America/Los_Angeles';

export default defineConfig({
  resolve: {
    alias: { '@app': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
