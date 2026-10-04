const LAYERS = ['Api', 'Domain', 'Ui'] as const;

export type Layer = (typeof LAYERS)[number];

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const PUBLIC_QUERY_HOOK = /^use[A-Z][A-Za-z0-9]*\.api$/;
const ROUTE_GUARDS = /^[a-z][A-Za-z0-9]*Guards$/;

export const isLayer = (segment: string): segment is Layer =>
  (LAYERS as readonly string[]).includes(segment);

export const isPascalCase = (name: string): boolean => PASCAL_CASE.test(name);

export const withoutCodeExtension = (path: string): string => path.replace(/\.tsx?$/, '');

export const fileStem = (path: string): string =>
  withoutCodeExtension(path.slice(path.lastIndexOf('/') + 1));

export const moduleOf = (path: string): string | null => {
  const [area, module] = path.split('/');
  return area === 'applications' && module !== undefined ? module : null;
};

export const layerOf = (path: string): Layer | null => {
  if (moduleOf(path) === null) {
    return null;
  }
  return path.split('/').slice(2, 4).find(isLayer) ?? null;
};

export const isPublicFace = (path: string): boolean => {
  const [, , layer, name, ...deeper] = withoutCodeExtension(path).split('/');
  if (name === undefined || deeper.length > 0) {
    return false;
  }
  return layer === 'Ui' || (layer === 'Api' && PUBLIC_QUERY_HOOK.test(name));
};

export const isRouteGuards = (path: string): boolean => {
  const [, , layer, name, ...deeper] = withoutCodeExtension(path).split('/');
  return layer === 'Api' && name !== undefined && deeper.length === 0 && ROUTE_GUARDS.test(name);
};

export const twinOwnerOf = (path: string, knownFiles: ReadonlySet<string>): string | null => {
  const folders = path.split('/').slice(0, -1);
  for (let depth = 1; depth <= folders.length; depth += 1) {
    const owner = folders.slice(0, depth).join('/');
    if (knownFiles.has(`${owner}.ts`) || knownFiles.has(`${owner}.tsx`)) {
      return owner;
    }
  }
  return null;
};
