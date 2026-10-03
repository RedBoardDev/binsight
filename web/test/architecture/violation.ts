export const RULES = [
  'forbidden-name',
  'module-shape',
  'pure-domain',
  'api-without-ui',
  'lib-without-react-or-app',
  'public-face-only',
  'relative-import-into-twin',
  'private-twin-folder',
  'standalone-service-worker',
  'spec-next-to-subject',
] as const;

export type Rule = (typeof RULES)[number];

export interface Violation {
  readonly rule: Rule;
  readonly message: string;
}
