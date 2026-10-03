import { posix } from 'node:path';

export type ImportTarget =
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'internal'; readonly path: string; readonly isRelative: boolean };

const APP_ALIAS = '@app/';

export const resolveImport = (importer: string, specifier: string): ImportTarget => {
  if (specifier.startsWith(APP_ALIAS)) {
    return { kind: 'internal', path: specifier.slice(APP_ALIAS.length), isRelative: false };
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const path = posix.normalize(posix.join(posix.dirname(importer), specifier));
    return { kind: 'internal', path, isRelative: true };
  }
  return { kind: 'package', name: specifier };
};

export const isOneOfPackages = (target: ImportTarget, packages: readonly string[]): boolean =>
  target.kind === 'package' &&
  packages.some((name) => target.name === name || target.name.startsWith(`${name}/`));
