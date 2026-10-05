import { type ImportTarget, isOneOfPackages, resolveImport } from './importTarget';
import {
  fileStem,
  isPublicFace,
  isRouteGuards,
  layerOf,
  moduleOf,
  twinOwnerOf,
  withoutCodeExtension,
} from './sourcePath';
import type { SourceFile } from './sourceTree';
import type { Rule, Violation } from './violation';

interface ImportEdge {
  readonly importer: string;
  readonly specifier: string;
  readonly target: ImportTarget;
  readonly knownFiles: ReadonlySet<string>;
}

type ImportRule = (edge: ImportEdge) => string | null;

const SPEC_FILE = /\.spec\.tsx?$/;

const REACT_AND_UI_PACKAGES = [
  'react',
  'react-dom',
  'react-aria',
  'react-aria-components',
  'react-hook-form',
  '@lingui/react',
  '@heroui',
  '@tanstack',
  'lucide-react',
];

const isInternalUnder = (target: ImportTarget, areas: readonly string[]): boolean =>
  target.kind === 'internal' && areas.some((area) => target.path.startsWith(`${area}/`));

const isInternalLayer = (target: ImportTarget, layers: readonly string[]): boolean =>
  target.kind === 'internal' && layers.includes(layerOf(target.path) ?? '');

const pureDomain: ImportRule = ({ importer, target }) => {
  if (layerOf(importer) !== 'Domain') {
    return null;
  }
  // This generated .d.ts contains declarations only. TypeScript requires import type for
  // these shapes; importing them does not bring the API client or I/O into Domain.
  if (target.kind === 'internal' && target.path === 'lib/api/generated/openapi') {
    return null;
  }
  const isForbidden =
    isOneOfPackages(target, REACT_AND_UI_PACKAGES) ||
    isInternalUnder(target, ['lib', 'core', 'routes']) ||
    isInternalLayer(target, ['Api', 'Ui']);
  return isForbidden
    ? 'Domain is pure TypeScript (zod and Lingui msg only): no React, UI library, TanStack, I/O, Api/ or Ui/.'
    : null;
};

const apiWithoutUi: ImportRule = ({ importer, target }) => {
  if (layerOf(importer) !== 'Api') {
    return null;
  }
  const isForbidden =
    isOneOfPackages(target, ['@heroui', 'lucide-react']) || isInternalLayer(target, ['Ui']);
  return isForbidden
    ? 'imports flow Ui → Api → Domain: Api/ never reaches Ui/ or the UI library.'
    : null;
};

const libWithoutReactOrApp: ImportRule = ({ importer, target }) => {
  if (!importer.startsWith('lib/')) {
    return null;
  }
  const isForbidden =
    isOneOfPackages(target, REACT_AND_UI_PACKAGES) ||
    isInternalUnder(target, ['applications', 'core', 'routes']);
  return isForbidden
    ? 'lib/ is infrastructure with no React and no business notion: it never imports applications/, core/ or routes/.'
    : null;
};

const publicFaceOnly: ImportRule = ({ importer, target }) => {
  if (target.kind !== 'internal') {
    return null;
  }
  const targetModule = moduleOf(target.path);
  if (targetModule === null || targetModule === 'Shared' || targetModule === moduleOf(importer)) {
    return null;
  }
  if (importer.startsWith('routes/') && isRouteGuards(target.path)) {
    return null;
  }
  return isPublicFace(target.path)
    ? null
    : `another module is reached only through Shared/ or its public face (Ui/<Component>.tsx or Api/use<X>.api.ts at the layer root; routes also reach Api/<x>Guards.ts).`;
};

const relativeImportIntoTwin: ImportRule = ({ importer, specifier, target }) => {
  if (target.kind !== 'internal' || !target.isRelative) {
    return null;
  }
  if (importer.startsWith('sw/')) {
    return specifier.startsWith('./') && !specifier.includes('../')
      ? null
      : 'the service worker imports its siblings with ./ and never leaves src/sw/.';
  }
  const twinPrefix = `./${fileStem(importer)}/`;
  return specifier.startsWith(twinPrefix) && !specifier.includes('../')
    ? null
    : `a relative import only reaches the file's own twin folder (${twinPrefix}…); use @app/… for everything else.`;
};

const privateTwinFolder: ImportRule = ({ importer, target, knownFiles }) => {
  if (target.kind !== 'internal') {
    return null;
  }
  const owner = twinOwnerOf(target.path, knownFiles);
  if (owner === null) {
    return null;
  }
  const isOwnTwin = withoutCodeExtension(importer) === owner || importer.startsWith(`${owner}/`);
  return isOwnTwin
    ? null
    : `${owner}/ is the private twin folder of ${owner}; import ${owner} instead.`;
};

const standaloneServiceWorker: ImportRule = ({ importer, specifier }) =>
  importer.startsWith('sw/') && specifier.startsWith('@app/')
    ? 'the service worker is a separate TypeScript project: it never imports from @app/.'
    : null;

const testHelpersInSpecsOnly: ImportRule = ({ importer, specifier }) =>
  specifier.startsWith('@test/') && !SPEC_FILE.test(importer)
    ? 'test helpers are for specs only: application code would ship them in the bundle.'
    : null;

const IMPORT_RULES: ReadonlyArray<readonly [Rule, ImportRule]> = [
  ['pure-domain', pureDomain],
  ['api-without-ui', apiWithoutUi],
  ['lib-without-react-or-app', libWithoutReactOrApp],
  ['public-face-only', publicFaceOnly],
  ['relative-import-into-twin', relativeImportIntoTwin],
  ['private-twin-folder', privateTwinFolder],
  ['standalone-service-worker', standaloneServiceWorker],
  ['test-helpers-in-specs-only', testHelpersInSpecsOnly],
];

const checkImport = (edge: ImportEdge): Violation[] =>
  IMPORT_RULES.flatMap(([rule, check]) => {
    const reason = check(edge);
    return reason === null
      ? []
      : [{ rule, message: `${edge.importer} must not import "${edge.specifier}": ${reason}` }];
  });

export const findImportViolations = (files: readonly SourceFile[]): Violation[] => {
  const knownFiles = new Set(files.map((file) => file.path));
  return files.flatMap((file) =>
    file.imports.flatMap((specifier) =>
      checkImport({
        importer: file.path,
        specifier,
        target: resolveImport(file.path, specifier),
        knownFiles,
      }),
    ),
  );
};
