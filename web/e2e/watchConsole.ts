import type { Page } from '@playwright/test';

// The browser logs every 4xx answer as a console error, and signed-out session checks and wrong
// passwords answer 401 on purpose; the scenario asserts those answers through the UI instead.
const EXPECTED_HTTP_ERROR = /^Failed to load resource: the server responded with a status of 401\b/;

// Collects console errors (a CSP violation is one) and uncaught page errors, so a test can
// assert that none happened.
export const watchConsole = (page: Page): string[] => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXPECTED_HTTP_ERROR.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  return problems;
};
