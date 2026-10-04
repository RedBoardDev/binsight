// Checks the gzip size of what the browser downloads, from the build manifest
// (dist/.vite/manifest.json), against bundle-budget.json. Fails when a budget is exceeded.
//
// - entry: the JavaScript every page loads first (index.html and its static imports);
// - each lazy chunk (a route, a lazy component): its own JavaScript, beyond what the entry and its
//   parent layouts already loaded;
// - the first load of each route: entry + parent layouts + the route;
// - CSS: every stylesheet of the build.
//
// Run by Node directly (type stripping), so this file stays a single module with no local import.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly css?: readonly string[];
}

export type Manifest = Readonly<Record<string, ManifestChunk>>;

export interface Budget {
  readonly firstLoadKb: number;
  readonly lazyChunkKb: number;
  readonly lazyChunkKbOverrides: Readonly<Record<string, number>>;
  readonly cssKb: number;
}

export interface Measure {
  readonly name: string;
  readonly kb: number;
  readonly limitKb: number;
}

const DIST = 'dist';
const MANIFEST_PATH = join(DIST, '.vite/manifest.json');
const BUDGET_PATH = 'bundle-budget.json';
const BYTES_PER_KB = 1024;
const ROUTE_SPLIT_SUFFIX = /\?tsr-split=.*$/;

// The files a chunk loads at once: its own and those of its static imports, recursively.
export const staticClosure = (manifest: Manifest, key: string): ReadonlySet<string> => {
  const files = new Set<string>();
  const visit = (current: string): void => {
    const chunk = manifest[current];
    if (chunk === undefined || files.has(chunk.file)) {
      return;
    }
    files.add(chunk.file);
    for (const imported of chunk.imports ?? []) {
      visit(imported);
    }
  };
  visit(key);
  return files;
};

// The layouts a route file renders inside: src/routes/_authenticated/stats.tsx sits in
// src/routes/_authenticated.tsx.
export const parentLayouts = (manifest: Manifest, key: string): string[] => {
  const path = key.replace(ROUTE_SPLIT_SUFFIX, '');
  const folders = path.split('/').slice(0, -1);
  return Object.keys(manifest).filter((candidate) => {
    const candidatePath = candidate.replace(ROUTE_SPLIT_SUFFIX, '');
    return (
      candidate !== key &&
      folders.some((_, index) => `${folders.slice(0, index + 1).join('/')}.tsx` === candidatePath)
    );
  });
};

const union = (sets: readonly ReadonlySet<string>[]): Set<string> =>
  new Set(sets.flatMap((set) => [...set]));

const difference = (files: ReadonlySet<string>, loaded: ReadonlySet<string>): Set<string> =>
  new Set([...files].filter((file) => !loaded.has(file)));

const isRoute = (key: string): boolean => key.startsWith('src/routes/');

export const measureBundle = (
  manifest: Manifest,
  budget: Budget,
  gzipKb: (files: ReadonlySet<string>) => number,
): Measure[] => {
  const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry === true);
  if (entryKey === undefined) {
    throw new Error('the build manifest has no entry');
  }
  const entry = staticClosure(manifest, entryKey);
  const lazyKeys = Object.keys(manifest).filter((key) => manifest[key]?.isDynamicEntry === true);
  const measures: Measure[] = [];
  for (const key of lazyKeys) {
    const layouts = union(
      parentLayouts(manifest, key).map((layout) => staticClosure(manifest, layout)),
    );
    const own = difference(staticClosure(manifest, key), union([entry, layouts]));
    const name = key.replace(ROUTE_SPLIT_SUFFIX, '');
    measures.push({
      name: `lazy ${name}`,
      kb: gzipKb(own),
      limitKb: budget.lazyChunkKbOverrides[name] ?? budget.lazyChunkKb,
    });
    if (isRoute(key)) {
      measures.push({
        name: `first load ${name}`,
        kb: gzipKb(union([entry, layouts, staticClosure(manifest, key)])),
        limitKb: budget.firstLoadKb,
      });
    }
  }
  const css = new Set(Object.values(manifest).flatMap((chunk) => chunk.css ?? []));
  return [
    { name: 'entry', kb: gzipKb(entry), limitKb: budget.firstLoadKb },
    ...measures,
    { name: 'css', kb: gzipKb(css), limitKb: budget.cssKb },
  ];
};

const gzipKbOnDisk = (files: ReadonlySet<string>): number =>
  [...files].reduce(
    (total, file) => total + gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length,
    0,
  ) / BYTES_PER_KB;

const main = (): void => {
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const budget: Budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  const measures = measureBundle(manifest, budget, gzipKbOnDisk);
  const overs = measures.filter((measure) => measure.kb > measure.limitKb);
  for (const { name, kb, limitKb } of measures) {
    const status = kb > limitKb ? 'OVER' : 'ok';
    console.info(`${status.padEnd(4)} ${kb.toFixed(1).padStart(7)} / ${limitKb} kB gzip  ${name}`);
  }
  if (overs.length > 0) {
    console.error(`${overs.length} bundle budget(s) exceeded: see ${BUDGET_PATH}`);
    process.exit(1);
  }
};

if (import.meta.main) {
  main();
}
