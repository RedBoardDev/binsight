const STATIC_IMPORT_OR_REEXPORT = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

export const extractImportSpecifiers = (source: string): string[] => {
  const specifiers = [STATIC_IMPORT_OR_REEXPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT].flatMap(
    (pattern) => Array.from(source.matchAll(pattern), (match) => match[1] ?? ''),
  );
  return [...new Set(specifiers)].filter((specifier) => specifier !== '');
};
