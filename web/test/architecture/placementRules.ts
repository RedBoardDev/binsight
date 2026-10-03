import { isLayer, isPascalCase } from './sourcePath';
import type { Violation } from './violation';

const FORBIDDEN_FOLDERS = ['types', 'utils', 'helpers', '__tests__'];
const FORBIDDEN_FILE_STEMS = ['types', 'utils', 'helpers'];
const SPEC_SUFFIX = /\.spec\.tsx?$/;
const CODE_FILE = /\.tsx?$/;

const checkForbiddenNames = (path: string): Violation[] => {
  const segments = path.split('/');
  const fileName = segments.at(-1) ?? '';
  const stem = fileName.split('.')[0] ?? '';
  const violations: Violation[] = segments
    .slice(0, -1)
    .filter((folder) => FORBIDDEN_FOLDERS.includes(folder))
    .map((folder) => ({
      rule: 'forbidden-name',
      message: `${path}: a folder named "${folder}/" is forbidden; group files by concept and name them after what they contain.`,
    }));
  if (CODE_FILE.test(fileName) && FORBIDDEN_FILE_STEMS.includes(stem)) {
    violations.push({
      rule: 'forbidden-name',
      message: `${path}: "${fileName}" says nothing; name the file after what it contains.`,
    });
  }
  if (CODE_FILE.test(fileName) && stem === 'index' && segments[0] !== 'routes') {
    violations.push({
      rule: 'forbidden-name',
      message: `${path}: index files are only for index routes under routes/; import the file that holds the code.`,
    });
  }
  return violations;
};

const checkModuleBody = (
  path: string,
  body: readonly string[],
  isShared: boolean,
): string | null => {
  const [first, ...rest] = body;
  if (first === undefined || rest.length === 0) {
    return `${path}: files go in Api/, Domain/ or Ui/, never at the root of a module.`;
  }
  if (isLayer(first)) {
    return null;
  }
  if (isShared && isPascalCase(first)) {
    return checkModuleBody(path, rest, false);
  }
  return `${path}: a module holds only Api/, Domain/ and Ui/ (Shared/ may also hold PascalCase sub-modules), not "${first}/".`;
};

const checkModuleShape = (path: string): Violation[] => {
  const [area, module, ...body] = path.split('/');
  if (area !== 'applications' || module === undefined) {
    return [];
  }
  if (body.length === 0) {
    return [{ rule: 'module-shape', message: `${path}: files go inside a module folder.` }];
  }
  if (!isPascalCase(module)) {
    return [
      {
        rule: 'module-shape',
        message: `${path}: module folders are PascalCase and singular ("${module}/" is not).`,
      },
    ];
  }
  const problem = checkModuleBody(path, body, module === 'Shared');
  return problem === null ? [] : [{ rule: 'module-shape', message: problem }];
};

const checkSpecHasSubject = (path: string, knownFiles: ReadonlySet<string>): Violation[] => {
  if (!SPEC_SUFFIX.test(path)) {
    return [];
  }
  const subject = path.replace(SPEC_SUFFIX, '');
  if (knownFiles.has(`${subject}.ts`) || knownFiles.has(`${subject}.tsx`)) {
    return [];
  }
  return [
    {
      rule: 'spec-next-to-subject',
      message: `${path}: a spec sits next to the file it tests, with the same base name.`,
    },
  ];
};

export const findPlacementViolations = (paths: readonly string[]): Violation[] => {
  const knownFiles = new Set(paths);
  return paths.flatMap((path) => [
    ...checkForbiddenNames(path),
    ...checkModuleShape(path),
    ...checkSpecHasSubject(path, knownFiles),
  ]);
};
