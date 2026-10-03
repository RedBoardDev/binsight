import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@app': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets', sourcemap: false },
});
