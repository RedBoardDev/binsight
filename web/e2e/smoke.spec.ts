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

test('signs in, shows the dashboard and signs out', async ({ page }, testInfo) => {
  const consoleProblems = watchConsole(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectNoA11yViolations(page);

  await signIn(page, 'not the password');
  await expect(page.getByText('Incorrect password.')).toBeVisible();

  await signIn(page, E2E_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Healthy')).toBeVisible();
  await expect(page.getByText(/^\d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Live updates: Live' })).toBeVisible({
    timeout: LIVE_WITHIN_MS,
  });
  await expectNoA11yViolations(page);

  // includeHidden: the menu hidden at this width is display:none, which getByRole skips.
  const menus = page.getByRole('navigation', { name: 'Main navigation', includeHidden: true });
  const [sidebar, tabBar] = [menus.first(), menus.last()];
  await expect(menus).toHaveCount(2);
  const isMobile = testInfo.project.name === 'mobile';
  await expect(isMobile ? tabBar : sidebar).toBeVisible();
  await expect(isMobile ? sidebar : tabBar).toBeHidden();

  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the dashboard' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=/);

  expect(consoleProblems).toEqual([]);
});
