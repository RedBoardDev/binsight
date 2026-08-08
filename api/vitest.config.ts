import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The persistence suites each boot a real Postgres in WASM (PGlite) and run the migrations against
    // it. A single such test legitimately takes 3-5s, and several files running in parallel on a busy
    // machine push individual tests past vitest's 5s default — which failed ~9 tests depending on load
    // alone, while every one of them passed in isolation. A suite whose result depends on machine load
    // is not a usable signal, so the budget is raised to match what these tests actually cost.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Nine test files boot their own PGlite instance. At vitest's default worker count that is up to
    // five WASM Postgres processes at once, which exhausts memory on a normal dev box: a worker gets
    // killed mid-run and vitest reports "Worker exited unexpectedly", silently dropping the tests that
    // worker still held. Capping concurrency trades ~30s of wall clock for a suite that always reports
    // the same result.
    minWorkers: 1,
    maxWorkers: 3,
  },
});
