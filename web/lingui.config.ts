import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'fr', 'de'],
  // No fallbackLocales: a fallback would let the build pass with an untranslated message.
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
      exclude: ['**/*.spec.*', 'src/routeTree.gen.ts', 'src/lib/api/generated/**'],
    },
  ],
  format: formatter({ origins: true, lineNumbers: false }),
});
