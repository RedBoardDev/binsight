import { describe, expect, it } from 'vitest';
import { extractImportSpecifiers } from './importSpecifiers';

describe('extractImportSpecifiers', () => {
  it('finds static, type-only, multi-line and side-effect imports', () => {
    const source = [
      "import { StrictMode } from 'react';",
      "import type { Messages } from '@lingui/core';",
      'import {',
      '  first,',
      '  second,',
      "} from '@app/core/i18n/locales';",
      "import '@app/core/theme/globals.css';",
    ].join('\n');

    expect(extractImportSpecifiers(source)).toEqual([
      'react',
      '@lingui/core',
      '@app/core/i18n/locales',
      '@app/core/theme/globals.css',
    ]);
  });

  it('finds re-exports and dynamic imports, template literals included', () => {
    const source = [
      "export { toast } from './toast/toast';",
      "const page = import('@app/applications/Auth/Ui/LoginPage');",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the template is the input under test.
      'const catalog = import(`../../locales/${locale}/messages.po`);',
    ].join('\n');

    expect(extractImportSpecifiers(source)).toEqual([
      './toast/toast',
      '@app/applications/Auth/Ui/LoginPage',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected specifier keeps the placeholder.
      '../../locales/${locale}/messages.po',
    ]);
  });

  it('ignores exports that do not come from another file', () => {
    expect(extractImportSpecifiers("export const from = 'here';")).toEqual([]);
  });
});
