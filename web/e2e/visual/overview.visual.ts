import { expect } from '@playwright/test';
import { overviewFixture } from '../../test/fixtures/overview';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

test('shows the overview server readings and opens its breakdown with the keyboard', async ({
  page,
}, testInfo) => {
  await page.route('**/api/v2/overview?*', (route) => route.fulfill({ json: overviewFixture() }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByText('+1.000', { exact: true })).toBeVisible();
  await expect(page.getByText('100.123', { exact: true })).toBeVisible();
  await expect(page.getByText('+1.336', { exact: true })).toBeVisible();
  await expect(page.getByText('+12.553', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /5 closes.*realized/ })).toHaveAttribute(
    'href',
    /day=2026-10-06/,
  );
  await page.evaluate('document.fonts.ready');
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-summary.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  const trigger = page.getByRole('button', { name: 'Show net worth breakdown' });
  for (
    let index = 0;
    index < 20 &&
    !(await page.evaluate<boolean>(
      'document.activeElement?.getAttribute("aria-label") === "Show net worth breakdown"',
    ));
    index += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS('box-shadow', /rgb/);
  await page.keyboard.press('Enter');
  const breakdown = page.getByRole('dialog', { name: 'Net worth breakdown' });
  await expect(breakdown).toBeVisible();
  await expect(breakdown).toContainText('Liquidity');
  await expect(breakdown).toContainText('Recoverable rent');
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(breakdown).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Hide amounts' }).click();
  await expect(page.getByText('+1.000', { exact: true })).toBeHidden();
  await expect(page.getByText('+2.6%', { exact: true })).toBeVisible();
  await trigger.click();
  await expect(breakdown).not.toContainText('4.000');
  await expect(breakdown).toContainText('amount hidden SOL');
  await expectNoA11yViolations(page);
  await expect
    .poll(() => page.evaluate('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  if (testInfo.project.name.startsWith('mobile')) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Hide amounts' }).click();
    await page.evaluate('localStorage.setItem("binsight.locale", "de")');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Übersicht', exact: true })).toBeVisible();
    await expect(page.getByText('+1,000', { exact: true })).toBeVisible();
    const netWorthBounds = await page
      .getByRole('button', { name: 'Aufschlüsselung des Nettovermögens anzeigen' })
      .boundingBox();
    const activePnlBounds = await page.getByText('Aktiver PnL', { exact: true }).boundingBox();
    if (netWorthBounds === null || activePnlBounds === null)
      throw new Error('The German summary labels are not visible');
    expect(activePnlBounds.x - netWorthBounds.x - netWorthBounds.width).toBeGreaterThanOrEqual(16);
    await page.evaluate('document.fonts.ready');
    await page.screenshot({
      path: `test-results/visual/${testInfo.project.name}/overview-summary-de.png`,
    });
    await expectNoA11yViolations(page);
    await expect
      .poll(() => page.evaluate('document.documentElement.scrollWidth'))
      .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  }
});

test('keeps unknown import progress unavailable and dates stale readings in the server time zone', async ({
  page,
}, testInfo) => {
  const fixture = overviewFixture();
  const reasons = [{ code: 'history_incomplete' as const, wallet: 'test-wallet', progress: null }];
  const unavailable = { exactness: 'unavailable' as const, reasons };
  fixture.freshness = { state: 'lagging', as_of: '2026-10-05T22:30:00Z', lag_seconds: 60 };
  fixture.today.window = {
    ...fixture.today.window,
    start: '2026-10-05T22:00:00Z',
    timezone: 'Europe/Berlin',
  };
  fixture.today.totals = {
    ...fixture.today.totals,
    count: 0,
    wins: 0,
    losses: 0,
    pnl: unavailable,
    pnl_pct: unavailable,
  };
  fixture.gain = { ...fixture.gain, value: unavailable, pct: unavailable };
  fixture.sync = {
    state: 'importing',
    lagging: [],
    importing: [
      { wallet: { address: 'test-wallet', label: 'Cold', color: 'wallet_1' }, progress: null },
    ],
  };
  await page.route('**/api/v2/overview?*', (route) => route.fulfill({ json: fixture }));
  await page.goto('/');
  await expect(page.getByText('Cold is importing history', { exact: true })).toBeVisible();
  await expect(page.getByText('Data from 12:30:00 AM', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing closed yet today', { exact: true })).toBeHidden();
  await expect(page.getByText('0.000', { exact: true })).toBeHidden();
  await expect(page.getByText('+1.336', { exact: true })).toBeVisible();
  const reason = page.getByRole('button', { name: 'Why not available?', exact: true }).first();
  await reason.click();
  await expect(page.getByRole('dialog', { name: 'Not available', exact: true })).toContainText(
    'History still importing',
  );
  await expect(page.getByRole('dialog', { name: 'Not available', exact: true })).not.toContainText(
    '0.0%',
  );
  await page.keyboard.press('Escape');
  await page.evaluate('document.fonts.ready');
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-importing.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  await expectNoA11yViolations(page);
  await expect
    .poll(() => page.evaluate('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
});

test('keeps USD figures and an explicit stale date after a failed refresh, then retries accessibly', async ({
  page,
}, testInfo) => {
  const fixture = overviewFixture();
  const usd = (figure: typeof fixture.net_worth.total): void => {
    if (figure.exactness !== 'unavailable') figure.value.unit = 'usd';
  };
  for (const figure of [
    fixture.today.totals.pnl,
    fixture.net_worth.total,
    fixture.net_worth.lp,
    fixture.net_worth.idle,
    fixture.net_worth.unclaimed_fees,
    fixture.net_worth.recoverable_rent,
    fixture.open.pnl,
    fixture.gain.value,
  ])
    usd(figure);
  let phase: 'initial' | 'failed' | 'recovered' = 'initial';
  let overviewReads = 0;
  await page.addInitScript('localStorage.setItem("binsight.currency", "usd")');
  await page.route('**/api/v2/overview?*', (route) => {
    overviewReads += 1;
    expect(new URL(route.request().url()).searchParams.get('currency')).toBe('usd');
    return phase === 'failed'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid' })
      : route.fulfill({ json: fixture });
  });
  await page.goto('/');
  await expect(page.getByText('+$1.00', { exact: true })).toBeVisible();
  // Window focus refreshes a stale query without changing the URL scope or the cached snapshot.
  await page.clock.install();
  await page.clock.fastForward(31_000);
  phase = 'failed';
  await page.evaluate('window.dispatchEvent(new Event("visibilitychange"))');
  await expect.poll(() => overviewReads).toBeGreaterThan(1);
  await expect(page.getByRole('alert')).toContainText('Something went wrong');
  await expect(page.getByText('Data from 12:00:00 PM', { exact: true })).toBeVisible();
  await expect(page.getByText('+$1.00', { exact: true })).toBeVisible();
  await page.evaluate('document.fonts.ready');
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-refetch-error-usd.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  await expectNoA11yViolations(page);
  await page.getByRole('button', { name: 'Hide amounts' }).click();
  await expect(page.getByText('+$1.00', { exact: true })).toBeHidden();
  await expect(page.getByText('+2.6%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show net worth breakdown' }).click();
  await expect(page.getByRole('dialog', { name: 'Net worth breakdown' })).not.toContainText(
    '$4.00',
  );
  await expect(page.getByRole('dialog', { name: 'Net worth breakdown' })).toContainText(
    'amount hidden USD',
  );
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  const readsBeforeRetry = overviewReads;
  phase = 'recovered';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByText('Data from 12:00:00 PM', { exact: true })).toBeHidden();
  await expect.poll(() => overviewReads).toBeGreaterThan(readsBeforeRetry);
});
