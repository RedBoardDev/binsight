import type { Page } from '@playwright/test';

// Collects console errors (a CSP violation is one) and uncaught page errors, so a test can
// assert that none happened.
export const watchConsole = (page: Page): string[] => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  return problems;
};
