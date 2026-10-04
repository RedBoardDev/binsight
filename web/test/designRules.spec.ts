import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findDesignViolations, type StyledSource } from './designRules/styleRules';

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const CHECKED_FILE = /\.(tsx?|css)$/;
// Specs may build any value they need; generated files are not ours to style.
const UNCHECKED_FILE = /\.spec\.tsx?$|\.gen\.ts$|^lib\/api\/generated\//;

const readStyledSources = (root: string): StyledSource[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => CHECKED_FILE.test(path) && !UNCHECKED_FILE.test(path))
    .sort()
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));

describe('the web app sources', () => {
  const sources = readStyledSources(SOURCE_ROOT);

  it('are read from src/', () => {
    expect(sources.map((source) => source.path)).toContain('core/theme/midnight.css');
  });

  it('follow the design rules', () => {
    expect(findDesignViolations(sources).map((violation) => violation.message)).toEqual([]);
  });
});
