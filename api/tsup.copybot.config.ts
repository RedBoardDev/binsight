import { defineConfig } from 'tsup';

/**
 * Build dedicated to the copy-bot processes (brain / coffre / validation tools). Unlike the API build
 * (`tsup.config.ts`, deps externalized), here we **bundle EVERYTHING** (`noExternal`): the Meteora SDK and anchor
 * ship broken ESM/CJS builds when consumed directly (dir-imports, missing default) — only a full esbuild bundle
 * resolves the interop. Only NATIVE modules stay external.
 */
export default defineConfig({
  // Committed build = the production brain + the on-chain bench's two CLIs (leader-control drives the leader-test
  // wallet, bench-reader reads positions/fidelity). Local-only scratch tools (diag-*, build-faithful-sim) are NOT
  // referenced here so the committed build never depends on gitignored scripts.
  entry: [
    'scripts/leader-control.ts',
    'scripts/bench-reader.ts',
    'src/copybot/brain/brain-main.ts',
  ],
  format: ['cjs'], // CJS: a CJS bundle handles require() of the builtins (ESM breaks on the SDK's CJS deps)
  target: 'node22',
  platform: 'node',
  outDir: 'dist/copybot',
  clean: true,
  noExternal: [/.*/], // bundle everything (SDK + anchor + web3 + …)
  external: ['bigint-buffer'], // native module → left as a runtime require
  esbuildOptions(options) {
    options.alias = { '@': new URL('./src', import.meta.url).pathname };
  },
});
