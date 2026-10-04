import { expect, type Page } from '@playwright/test';
import { E2E_PASSWORD } from './binsightServer';
import { expectNoA11yViolations } from './expectNoA11yViolations';
import { test } from './fixtures';
import { watchConsole } from './watchConsole';

const LIVE_WITHIN_MS = 10_000;

const signIn = async (page: Page, password: string): Promise<void> => {
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
};

test('signs in, finds its way around the shell and signs out', async ({ page }, testInfo) => {
  const consoleProblems = watchConsole(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectNoA11yViolations(page);

  await signIn(page, 'not the password');
  await expect(page.getByText('Incorrect password.')).toBeVisible();

  await signIn(page, E2E_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live updates:' })).toHaveText(
    'Live updates: Live',
    {
      timeout: LIVE_WITHIN_MS,
    },
  );
  await expectNoA11yViolations(page);

  // includeHidden: the navigation of the other size is display:none, which getByRole skips.
  const navigations = page.getByRole('navigation', { name: 'Main', includeHidden: true });
  const [topBar, tabBar] = [navigations.first(), navigations.last()];
  await expect(navigations).toHaveCount(2);
  const isMobile = testInfo.project.name === 'mobile';
  await expect(isMobile ? tabBar : topBar).toBeVisible();
  await expect(isMobile ? topBar : tabBar).toBeHidden();

  await page.goto('/health');
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
  await expect(page.getByText('Healthy')).toBeVisible();
  await expect(page.getByText(/^\d+\.\d+\.\d+/)).toBeVisible();
  await expectNoA11yViolations(page);

  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the overview' })).toBeVisible();

  // The design reference exists in development only.
  await page.goto('/design');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=/);

  expect(consoleProblems).toEqual([]);
});
