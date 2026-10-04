import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// globals.css imports the stylesheet of each HeroUI component the app uses, not all of them: a
// component used without its stylesheet renders unstyled, and nothing else would notice.

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const GLOBALS_CSS = join(SOURCE_ROOT, 'core/theme/globals.css');
const REACT_COMPONENTS = fileURLToPath(
  new URL('../node_modules/@heroui/react/dist/components', import.meta.url),
);
const STYLES = fileURLToPath(new URL('../node_modules/@heroui/styles/dist', import.meta.url));

const HEROUI_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'@heroui\/react'/g;
const STYLE_VARIANTS = /import\s*\{([^}]*)\}\s*from\s*'@heroui\/styles'/g;
const SIBLING_COMPONENT = /from\s*'\.\.\/([a-z-]+)\//g;

const kebabCase = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// HeroUI names a few folders in one word (TextField lives in textfield/).
const componentFolder = (name: string): string => {
  const folder = kebabCase(name);
  return existsSync(join(REACT_COMPONENTS, folder)) ? folder : folder.replaceAll('-', '');
};

const sourceFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.spec\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

const usedComponentFolders = (): Set<string> => {
  const folders = new Set<string>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    for (const [, names = ''] of readFileSync(file, 'utf8').matchAll(HEROUI_IMPORT)) {
      for (const raw of names.split(',')) {
        const [name = ''] = raw.trim().split(/\s+as\s+/);
        if (name === '' || name.startsWith('type ')) {
          continue;
        }
        folders.add(componentFolder(name.replace(/Variants$/, '')));
      }
    }
  }
  return folders;
};

// A component needs its own stylesheet and those of the components it builds on (a dropdown is a
// popover holding a menu), as HeroUI's own imports say.
const stylesheetsOf = (folder: string, seen = new Set<string>()): Set<string> => {
  const sheets = new Set<string>();
  const directory = join(REACT_COMPONENTS, folder);
  if (seen.has(folder) || !existsSync(directory)) {
    return sheets;
  }
  seen.add(folder);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js'))) {
    const code = readFileSync(join(directory, file), 'utf8');
    for (const [, names = ''] of code.matchAll(STYLE_VARIANTS)) {
      for (const name of names.split(',')) {
        sheets.add(kebabCase(name.trim().replace(/Variants$/, '')));
      }
    }
    for (const [, sibling = ''] of code.matchAll(SIBLING_COMPONENT)) {
      for (const sheet of stylesheetsOf(sibling, seen)) {
        sheets.add(sheet);
      }
    }
  }
  return sheets;
};

const requiredImports = (): string[] => {
  const sheets = new Set<string>();
  for (const folder of usedComponentFolders()) {
    for (const sheet of stylesheetsOf(folder)) {
      sheets.add(sheet);
    }
  }
  return [...sheets]
    .flatMap((sheet) => [`components/${sheet}.css`, `themes/default/components/${sheet}.css`])
    .filter((path) => existsSync(join(STYLES, path)))
    .map((path) => `@heroui/styles/${path}`)
    .sort();
};

describe('the HeroUI stylesheets', () => {
  it('are imported for every HeroUI component the app uses', () => {
    const globals = readFileSync(GLOBALS_CSS, 'utf8');

    const missing = requiredImports().filter((path) => !globals.includes(`"${path}"`));

    expect(missing).toEqual([]);
  });

  it('know the components the app uses', () => {
    const unknown = [...usedComponentFolders()].filter(
      (folder) => !existsSync(join(REACT_COMPONENTS, folder)),
    );

    expect(unknown).toEqual([]);
  });
});
