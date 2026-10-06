import { expect, type Page } from '@playwright/test';
import type { ApiSchema } from '../src/lib/api/apiSchema';
import { E2E_PASSWORD } from './binsightServer';
import { expectNoA11yViolations } from './expectNoA11yViolations';
import { test } from './fixtures';
import { watchConsole } from './watchConsole';

const LIVE_WITHIN_MS = 10_000;

test.use({ mode: 'demo' });

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

  const overviewRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/overview' &&
      response.request().method() === 'GET',
  );
  const seriesRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/stats/series' &&
      response.request().method() === 'GET',
  );
  await signIn(page, E2E_PASSWORD);
  const overviewResponse = await overviewRead;
  expect(overviewResponse.status()).toBe(200);
  const overview: ApiSchema<'Overview'> = await overviewResponse.json();
  expect(overview).toMatchObject({
    today: { totals: { pnl: { exactness: expect.any(String) } } },
    net_worth: { total: { exactness: expect.any(String) } },
  });
  const seriesResponse = await seriesRead;
  expect(seriesResponse.status()).toBe(200);
  const series: ApiSchema<'StatsSeries'> = await seriesResponse.json();
  expect(series.series).toBe('real_pnl');
  expect(series.bucket).toBe('day');
  expect(series.window).toEqual(overview.gain.window);
  expect(series.header.value).toEqual(overview.gain.value);
  expect(series.points.at(-1)?.line).toEqual(overview.gain.value);
  expect(series.points.at(-1)?.line_share_of_net_worth).toEqual(overview.gain.pct);
  const chart = page.getByRole('slider', { name: 'Real PnL', exact: true });
  await expect(chart).toBeVisible();
  await chart.focus();
  await page.keyboard.press('End');
  await expect(chart).toHaveAttribute('aria-valuenow', String(series.points.length - 1));
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeAttached();
  await expect(page.getByRole('region', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live updates:' })).toHaveText(
    'Live updates: Live',
    {
      timeout: LIVE_WITHIN_MS,
    },
  );
  await expectNoA11yViolations(page);
  await page.screenshot({
    path: `test-results/actual-demo/overview-${testInfo.project.name}.png`,
    fullPage: testInfo.project.name === 'desktop',
  });

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

  // The test harness exists for the Vite dev server only: the shipped app never serves it.
  const harness = await page.request.get('/test/harness/main.tsx');
  expect(await harness.text()).not.toContain('HarnessPage');
  await page.goto('/test/harness/');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Test harness' })).toBeHidden();

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=/);

  expect(consoleProblems).toEqual([]);
});

test.describe('a fresh chain instance', () => {
  test.use({ mode: 'chain' });

  test('explains that figures are not ready without showing an empty portfolio', async ({
    page,
  }) => {
    const unexpectedErrors: string[] = [];
    const expectedOverviewErrors: string[] = [];
    page.on('pageerror', (error) => unexpectedErrors.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      if (
        /^Failed to load resource: the server responded with a status of 401\b/.test(message.text())
      )
        return;
      if (
        /^Failed to load resource: the server responded with a status of 503\b/.test(
          message.text(),
        ) &&
        URL.canParse(location) &&
        new URL(location).pathname === '/api/v1/overview'
      ) {
        expectedOverviewErrors.push(location);
      } else unexpectedErrors.push(`console: ${message.text()} (${location})`);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    const overviewRead = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/overview',
    );
    await signIn(page, E2E_PASSWORD);
    const response = await overviewRead;
    expect(response.status()).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'data_not_ready' } });
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeAttached();
    await expect(page.getByRole('alert')).toContainText('still preparing your figures');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByText('Nothing closed yet today', { exact: true })).toBeHidden();
    await expect(page.getByText('0.000', { exact: true })).toBeHidden();
    await expectNoA11yViolations(page);
    expect(expectedOverviewErrors.length).toBeGreaterThan(0);
    expect(unexpectedErrors).toEqual([]);
  });
});
