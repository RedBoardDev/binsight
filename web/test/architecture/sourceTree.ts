import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { extractImportSpecifiers } from './importSpecifiers';

export interface SourceFile {
  readonly path: string;
  readonly imports: readonly string[];
}

const GENERATED_PATHS = ['routeTree.gen.ts', 'lib/api/generated/'];
const CODE_FILE = /\.tsx?$/;

const toPosix = (path: string): string => path.split(sep).join('/');

const isGenerated = (path: string): boolean =>
  GENERATED_PATHS.some((generated) => path === generated || path.startsWith(generated));

export const readSourceTree = (root: string): SourceFile[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name))))
    .filter((path) => !isGenerated(path))
    .sort()
    .map((path) => ({
      path,
      imports: CODE_FILE.test(path)
        ? extractImportSpecifiers(readFileSync(join(root, path), 'utf8'))
        : [],
    }));
