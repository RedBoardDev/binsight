import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The core package ships TypeScript sources, so it is bundled into the API. Its OWN dependencies must
// stay external like the API's: bundled, CommonJS ones (undici) break on their dynamic requires.
const core = JSON.parse(
  readFileSync(new URL('../packages/solana-core/package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  outDir: 'dist',
  noExternal: ['@binsight/solana-core'],
  external: Object.keys(core.dependencies ?? {}),
  // Resolve the `@/*` alias to src/* at build time.
  esbuildOptions(options) {
    options.alias = { '@': new URL('./src', import.meta.url).pathname };
  },
});
