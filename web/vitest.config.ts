import { fileURLToPath } from 'node:url';
import { lingui } from '@lingui/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), lingui({ macroTransform: true })],
  resolve: {
    alias: {
      '@app': fileURLToPath(new URL('./src', import.meta.url)),
      '@test': fileURLToPath(new URL('./test', import.meta.url)),
    },
  },
  test: {
    // The host shares its cores with production and with other builds: under that load a test
    // that renders the whole app takes several seconds, and 5 s deadlines failed tests that were
    // only slow. A deadline is not a retry: a test that hangs still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Two workers leave room for the cargo builds that run next to the web tests.
    maxWorkers: 2,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/**/Domain/**/*.spec.ts',
            'src/lib/**/*.spec.ts',
            'src/sw/**/*.spec.ts',
            'src/core/**/*.spec.ts',
            'scripts/**/*.spec.ts',
            'test/**/*.spec.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./test/setupDom.ts'],
          include: ['src/**/*.spec.{ts,tsx}'],
          exclude: ['src/**/Domain/**', 'src/lib/**', 'src/sw/**', 'src/core/**/*.spec.ts'],
        },
      },
    ],
  },
});
