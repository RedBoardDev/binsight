import { describe, expect, it } from 'vitest';
import { findImportViolations } from './importRules';
import type { SourceFile } from './sourceTree';
import type { Rule } from './violation';

const OTHER_FILES: SourceFile[] = [
  { path: 'applications/Auth/Ui/LoginForm.tsx', imports: [] },
  { path: 'applications/Auth/Ui/LoginForm/PasswordField.tsx', imports: [] },
];

const rulesBrokenBy = (path: string, specifier: string): Rule[] =>
  findImportViolations([...OTHER_FILES, { path, imports: [specifier] }]).map(
    (violation) => violation.rule,
  );

describe('findImportViolations', () => {
  it('accepts imports that follow the layers', () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ['applications/Auth/Domain/loginForm.ts', 'zod'],
      ['applications/Auth/Domain/loginForm.ts', '@lingui/core/macro'],
      ['applications/Auth/Api/login.ts', '@app/applications/Auth/Domain/loginForm'],
      ['applications/Auth/Ui/LoginPage.tsx', '@app/applications/Auth/Api/useSession.api'],
      ['applications/Auth/Ui/LoginForm.tsx', './LoginForm/PasswordField'],
      ['applications/Auth/Ui/LoginForm/PasswordField.tsx', '@app/applications/Shared/Ui/toast'],
      ['applications/Dashboard/Ui/DashboardPage.tsx', '@app/applications/Health/Ui/HealthCard'],
      ['applications/Dashboard/Ui/DashboardPage.tsx', '@app/applications/Health/Api/useHealth.api'],
      ['routes/login.tsx', '@app/applications/Auth/Ui/LoginPage'],
      ['lib/api/client.ts', 'openapi-fetch'],
      ['sw/sw.ts', './navigationDenylist'],
    ];
    for (const [path, specifier] of allowed) {
      expect(rulesBrokenBy(path, specifier), `${path} → ${specifier}`).toEqual([]);
    }
  });

  it('keeps Domain free of React, UI, TanStack, I/O and the outer layers', () => {
    const domain = 'applications/Auth/Domain/loginForm.ts';
    expect(rulesBrokenBy(domain, 'react')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, '@heroui/react')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, '@tanstack/react-query')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, 'lucide-react')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, '@app/lib/api/client')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, '@app/core/i18n/i18n')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, '@app/applications/Auth/Api/login')).toEqual(['pure-domain']);
    expect(rulesBrokenBy(domain, '@app/applications/Shared/Ui/toast')).toEqual(['pure-domain']);
  });

  it('keeps Api away from Ui and the UI library', () => {
    const api = 'applications/Auth/Api/login.ts';
    expect(rulesBrokenBy(api, '@app/applications/Auth/Ui/LoginPage')).toEqual(['api-without-ui']);
    expect(rulesBrokenBy(api, '@heroui/react')).toEqual(['api-without-ui']);
  });

  it('keeps lib free of React and of the app', () => {
    const lib = 'lib/sse/eventStream.ts';
    expect(rulesBrokenBy(lib, 'react')).toEqual(['lib-without-react-or-app']);
    expect(rulesBrokenBy(lib, '@app/core/query/createQueryClient')).toEqual([
      'lib-without-react-or-app',
    ]);
    expect(rulesBrokenBy(lib, '@app/applications/Shared/Domain/entityName')).toEqual([
      'lib-without-react-or-app',
    ]);
  });

  it('reaches another module only through its public face', () => {
    const page = 'applications/Dashboard/Ui/DashboardPage.tsx';
    expect(rulesBrokenBy(page, '@app/applications/Health/Api/getHealth')).toEqual([
      'public-face-only',
    ]);
    expect(rulesBrokenBy(page, '@app/applications/Health/Domain/healthStatus')).toEqual([
      'public-face-only',
    ]);
    expect(rulesBrokenBy('routes/login.tsx', '@app/applications/Auth/Api/login')).toEqual([
      'public-face-only',
    ]);
  });

  it('allows relative imports only into the own twin folder', () => {
    const form = 'applications/Auth/Ui/LoginForm.tsx';
    expect(rulesBrokenBy(form, './LoginPage')).toEqual(['relative-import-into-twin']);
    expect(rulesBrokenBy(form, '../Api/login')).toEqual(['relative-import-into-twin']);
    expect(rulesBrokenBy('sw/sw.ts', '../core/theme/themePreference')).toEqual([
      'relative-import-into-twin',
    ]);
  });

  it('keeps a twin folder private to its owner', () => {
    expect(
      rulesBrokenBy(
        'applications/Auth/Ui/LoginPage.tsx',
        '@app/applications/Auth/Ui/LoginForm/PasswordField',
      ),
    ).toEqual(['private-twin-folder']);
  });

  it('keeps the service worker out of the app', () => {
    expect(rulesBrokenBy('sw/sw.ts', '@app/core/theme/themePreference')).toEqual([
      'standalone-service-worker',
    ]);
  });
});
