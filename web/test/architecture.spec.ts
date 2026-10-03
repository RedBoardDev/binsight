import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findImportViolations } from './architecture/importRules';
import { findPlacementViolations } from './architecture/placementRules';
import { readSourceTree } from './architecture/sourceTree';

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));

describe('the web app source tree', () => {
  const files = readSourceTree(SOURCE_ROOT);

  it('is read from src/', () => {
    expect(files.map((file) => file.path)).toContain('main.tsx');
  });

  it('places every file where the module rules allow', () => {
    const violations = findPlacementViolations(files.map((file) => file.path));
    expect(violations.map((violation) => violation.message)).toEqual([]);
  });

  it('imports only along the module layers', () => {
    const violations = findImportViolations(files);
    expect(violations.map((violation) => violation.message)).toEqual([]);
  });
});
