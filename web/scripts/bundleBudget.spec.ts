import { describe, expect, it } from 'vitest';
import {
  type Budget,
  type Manifest,
  measureBundle,
  parentLayouts,
  staticClosure,
} from './bundleBudget';

const MANIFEST: Manifest = {
  'index.html': { file: 'entry.js', isEntry: true, imports: ['_shared.js'], css: ['app.css'] },
  '_shared.js': { file: 'shared.js' },
  'src/routes/_authenticated.tsx?tsr-split=component': {
    file: 'layout.js',
    isDynamicEntry: true,
    imports: ['_shared.js', '_shell.js'],
  },
  '_shell.js': { file: 'shell.js' },
  'src/routes/_authenticated/stats.tsx?tsr-split=component': {
    file: 'stats.js',
    isDynamicEntry: true,
    imports: ['_shell.js', '_chart.js'],
  },
  '_chart.js': { file: 'chart.js' },
  'src/routes/login.tsx?tsr-split=component': { file: 'login.js', isDynamicEntry: true },
};

const BUDGET: Budget = {
  firstLoadKb: 260,
  lazyChunkKb: 60,
  lazyChunkKbOverrides: { 'src/routes/login.tsx': 30 },
  cssKb: 50,
};

// Every file weighs 1 kB, so a measure is the number of files it counts.
const countFiles = (files: ReadonlySet<string>): number => files.size;

describe('staticClosure', () => {
  it('follows the static imports of a chunk', () => {
    expect(staticClosure(MANIFEST, 'index.html')).toEqual(new Set(['entry.js', 'shared.js']));
  });
});

describe('parentLayouts', () => {
  it('finds the layout a route renders in', () => {
    expect(
      parentLayouts(MANIFEST, 'src/routes/_authenticated/stats.tsx?tsr-split=component'),
    ).toEqual(['src/routes/_authenticated.tsx?tsr-split=component']);
    expect(parentLayouts(MANIFEST, 'src/routes/login.tsx?tsr-split=component')).toEqual([]);
  });
});

describe('measureBundle', () => {
  const measures = measureBundle(MANIFEST, BUDGET, countFiles);
  const measure = (name: string) => measures.find((candidate) => candidate.name === name);

  it('counts in a route only what its entry and layouts did not load', () => {
    expect(measure('lazy src/routes/_authenticated/stats.tsx')).toEqual({
      name: 'lazy src/routes/_authenticated/stats.tsx',
      kb: 2,
      limitKb: 60,
    });
  });

  it('counts the first load of a route with its entry and layouts', () => {
    expect(measure('first load src/routes/_authenticated/stats.tsx')?.kb).toBe(6);
  });

  it('applies the budget of a named chunk', () => {
    expect(measure('lazy src/routes/login.tsx')?.limitKb).toBe(30);
  });

  it('counts every stylesheet', () => {
    expect(measure('css')).toEqual({ name: 'css', kb: 1, limitKb: 50 });
  });
});
