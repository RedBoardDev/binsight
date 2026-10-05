import { test as base, expect } from '@playwright/test';
import { watchConsole } from './watchConsole';

export const test = base.extend<{ browserErrors: readonly string[] }>({
  browserErrors: [
    async ({ page }, use) => {
      const errors = watchConsole(page);
      await use(errors);
      expect(errors, 'the page renders without browser errors').toEqual([]);
    },
    { auto: true },
  ],
});
