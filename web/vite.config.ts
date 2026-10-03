import { fileURLToPath } from 'node:url';
import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxy = {
  // Same origin seen from the browser, so the session cookie and the server's CSRF check both work.
  // changeOrigin must stay false, or the Origin/Host pair no longer matches and every write is refused.
  '/api': {
    target: process.env.BINSIGHT_DEV_API_URL ?? 'http://127.0.0.1:8080',
    changeOrigin: false,
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [
    // Reads tsr.config.json. It must come before react(), which would otherwise see the routes untransformed.
    tanstackRouter({ target: 'react' }),
    react(),
    // Without failOnMissing, a message missing in French or German would ship in English unnoticed.
    lingui({
      macroTransform: true,
      failOnMissing: mode === 'production',
      failOnCompileError: true,
    }),
    tailwindcss(),
  ],
  resolve: { alias: { '@app': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets', sourcemap: false },
}));
