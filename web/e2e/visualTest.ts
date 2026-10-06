import { test as base, expect } from '@playwright/test';
import { overviewFixture } from '../test/fixtures/overview';
import { watchConsole } from './watchConsole';

export const test = base.extend<{ browserErrors: readonly string[] }>({
  page: async ({ page }, use) => {
    await page.route('**/api/v1/overview?*', (route) => route.fulfill({ json: overviewFixture() }));
    await use(page);
  },
  browserErrors: [
    async ({ page }, use) => {
      const errors = watchConsole(page);
      await use(errors);
      expect(errors, 'the page renders without browser errors').toEqual([]);
    },
    { auto: true },
  ],
});
