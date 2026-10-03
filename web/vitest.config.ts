import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@app': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
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
