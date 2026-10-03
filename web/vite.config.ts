import { fileURLToPath } from 'node:url';
import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { type ManifestOptions, VitePWA } from 'vite-plugin-pwa';

const manifest: Partial<ManifestOptions> = {
  id: '/',
  name: 'binsight',
  short_name: 'binsight',
  description: 'Exact PnL for your Meteora DLMM liquidity positions.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0b0f14',
  theme_color: '#0b0f14',
  icons: [
    { src: '/icons/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
    { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
    {
      src: '/icons/maskable-icon-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};

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
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      registerType: 'prompt',
      // 'inline' or 'auto' would add an inline script, which the server's CSP (script-src 'self')
      // blocks; main.tsx registers the worker through the UpdatePrompt instead.
      injectRegister: false,
      manifest,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        globIgnores: ['third-party-licenses.txt'],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { '@app': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets', sourcemap: false },
}));
