import { expect, type Page } from '@playwright/test';
import { overviewFixture } from '../../test/fixtures/overview';
import { statsSeriesFixture } from '../../test/fixtures/statsSeries';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

const focusChartWithKeyboard = async (page: Page): Promise<void> => {
  for (let count = 0; count < 25; count += 1) {
    if (await page.evaluate<boolean>('document.activeElement?.getAttribute("role") === "slider"'))
      return;
    await page.keyboard.press('Tab');
  }
  throw new Error('The chart is not reachable with Tab');
};

test('shows the real pnl layout and four server readings through native keyboard focus', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const slider = page.getByRole('slider', { name: 'Real PnL', exact: true });
  const chart = page.getByRole('figure', { name: 'Real PnL', exact: true });
  await expect(slider).toBeVisible();
  await page.evaluate('document.fonts.ready');
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-pulse.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  const keyRow = page.getByRole('region', { name: 'Today' });
  const figuresBox = await keyRow.boundingBox();
  const chartBox = await chart.boundingBox();
  if (figuresBox === null || chartBox === null)
    throw new Error('Both summary and chart need bounds');
  if (testInfo.project.name.startsWith('mobile'))
    expect(chartBox.y).toBeGreaterThan(figuresBox.y + figuresBox.height);
  else expect(chartBox.x - figuresBox.x).toBeGreaterThanOrEqual(360);
  await focusChartWithKeyboard(page);
  await expect(slider).toBeFocused();
  await expect(slider).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /Sep 30; Profit: plus 1.000 SOL.*plus 2.41%.*Cumulative: plus 1.000 SOL.*plus 20.40%/,
  );
  // The desktop tooltip shows the shares of net worth; the phone's one-line reading leaves them
  // to the slider's spoken value.
  if (testInfo.project.name.startsWith('desktop')) await expect(chart).toContainText('+20.40%');
  await expect(chart.locator('svg text').first()).toHaveText('Sep 30');
  if (testInfo.project.name.startsWith('desktop')) {
    const tooltip = chart.locator('.pointer-events-none');
    await expect(tooltip).toHaveCSS('pointer-events', 'none');
    await expect(tooltip.getByRole('button')).toHaveCount(0);
    const tooltipBox = await tooltip.boundingBox();
    if (tooltipBox === null) throw new Error('The tooltip needs bounds');
    expect(tooltipBox.width).toBe(220);
    expect(tooltipBox.x).toBeGreaterThanOrEqual(chartBox.x);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
  } else await expect(chart.getByRole('radiogroup', { name: 'Period' })).toBeHidden();
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-pulse-readout.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  await expectNoA11yViolations(page);
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', /Cumulative: plus 12.553 SOL/);
  if (testInfo.project.name.startsWith('desktop')) {
    const rightBox = await chart.locator('.pointer-events-none').boundingBox();
    if (rightBox === null) throw new Error('The last tooltip needs bounds');
    expect(rightBox.x).toBeGreaterThanOrEqual(chartBox.x);
    expect(rightBox.x + rightBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
  }
  await page.keyboard.press('.');
  await expect(slider).toHaveAttribute('aria-valuetext', /amount hidden SOL.*plus 20.40%/);
  await expect(chart).not.toContainText('12.553');
  if (testInfo.project.name.startsWith('desktop')) await expect(chart).toContainText('+20.40%');
  await expect(chart.getByRole('img')).toHaveAttribute('aria-label', /amount hidden SOL/);
  await expect(chart.getByRole('table')).not.toContainText('6.363');
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(chart.getByRole('radiogroup', { name: 'Period' })).toBeVisible();
  await expect(chart.locator('[aria-live]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
});

test('cuts unavailable geometry and exposes estimate and import reasons without tooltip tab stops', async ({
  page,
}, testInfo) => {
  const fixture = statsSeriesFixture();
  const estimated = fixture.points[2];
  const unavailable = fixture.points[3];
  if (estimated === undefined || unavailable === undefined)
    throw new Error('The fixture needs middle points');
  const estimate = {
    exactness: 'estimated' as const,
    value: { amount: '4.1905', unit: 'sol' as const },
    reasons: [
      {
        code: 'reconstructed_history' as const,
        wallet: 'test-wallet',
        until: '2026-10-01T00:00:00Z',
      },
    ],
  };
  estimated.bar = { ...estimate, value: { amount: '3.4', unit: 'sol' } };
  estimated.line = estimate;
  unavailable.bar = null;
  unavailable.bar_share_of_net_worth = null;
  unavailable.line = {
    exactness: 'unavailable',
    reasons: [{ code: 'history_incomplete', wallet: 'test-wallet', progress: null }],
  };
  unavailable.line_share_of_net_worth = unavailable.line;
  await page.route('**/api/v1/stats/series?*', (route) => route.fulfill({ json: fixture }));
  await page.goto('/');
  const slider = page.getByRole('slider', { name: 'Real PnL', exact: true });
  const chart = page.getByRole('figure', { name: 'Real PnL', exact: true });
  await expect(slider).toBeVisible();
  await focusChartWithKeyboard(page);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', /estimated.*Reconstructed/);
  await expect(chart.locator('path[stroke-dasharray="4 4"]')).not.toHaveCount(0);
  // An estimated day is told by the dashed curve and the readout, never by a texture on its bar.
  await expect(chart.locator('rect[fill^="url"]')).toHaveCount(0);
  if (testInfo.project.name.startsWith('desktop'))
    await expect(chart.getByRole('button', { name: /Why/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /Profit: not available.*Cumulative: not available.*History still importing/,
  );
  await expect(chart.getByRole('table')).toContainText('History still importing.');
  await expect(chart.locator('circle')).toHaveCount(0);
  if (testInfo.project.name.startsWith('desktop'))
    await expect(chart.getByRole('button', { name: /Why/ })).toHaveCount(0);
  await page.evaluate('document.fonts.ready');
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-pulse-unavailable.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  await expectNoA11yViolations(page);
});

test('keeps the daily query error explicit while the period controls can select a shorter window', async ({
  page,
}) => {
  await page.route('**/api/v1/stats/series?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('series')).toBe('real_pnl');
    expect(query.get('bucket')).toBe('day');
    return query.get('period') === 'all'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid' })
      : route.fulfill({ json: statsSeriesFixture() });
  });
  await page.goto('/?period=all');
  const section = page.getByRole('region', { name: 'Real PnL', exact: true });
  await expect(section.getByRole('alert')).toContainText('Something went wrong');
  await expect(section.getByRole('radiogroup', { name: 'Period' })).toBeVisible();
  await expect(section.getByRole('slider')).toHaveCount(0);
  await section.getByRole('radio', { name: '7d', exact: true }).click();
  await expect(page).toHaveURL(/period=7d/);
  await expect(section.getByRole('slider')).toBeVisible();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('preserves vertical touch scrolling and only scrubs after horizontal movement', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Native touch is checked on phones');
  await page.goto('/');
  const slider = page.getByRole('slider', { name: 'Real PnL', exact: true });
  await expect(slider).toBeVisible();
  await page.evaluate('document.querySelector("main").style.minHeight = "1700px"');
  const box = await slider.boundingBox();
  if (box === null) throw new Error('The chart needs pointer bounds');
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width / 3;
  const y = box.y + box.height / 2;
  const plotY = box.y;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + 5, y }],
  });
  await expect(page.getByRole('radiogroup', { name: 'Period' })).toBeVisible();
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + 35, y }],
  });
  await expect(page.getByRole('radiogroup', { name: 'Period' })).toBeHidden();
  const activeBox = await slider.boundingBox();
  expect(activeBox?.y).toBe(plotY);
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.getByRole('radiogroup', { name: 'Period' })).toBeVisible();
  for (let gesture = 0; gesture < 2; gesture += 1) {
    const current = await slider.boundingBox();
    if (current === null) throw new Error('The chart needs current bounds');
    const before = await page.evaluate<number>('window.scrollY');
    const touchX = current.x + current.width / 2;
    const touchY = current.y + current.height / 2;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: touchX, y: touchY }],
    });
    for (const distance of [20, 45, 75])
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: touchX + 2, y: touchY - distance }],
      });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate('window.scrollY')).toBeGreaterThan(before + 20);
    await expect(page.getByRole('radiogroup', { name: 'Period' })).toBeVisible();
  }
  await session.detach();
});

test('preserves the original USD chart readings and percentages after a failed refresh', async ({
  page,
}, testInfo) => {
  const overview = overviewFixture();
  for (const figure of [
    overview.today.totals.pnl,
    overview.net_worth.total,
    overview.net_worth.lp,
    overview.net_worth.idle,
    overview.net_worth.unclaimed_fees,
    overview.net_worth.recoverable_rent,
    overview.open.pnl,
    overview.gain.value,
  ]) {
    if (figure.exactness !== 'unavailable') figure.value.unit = 'usd';
  }
  await page.route('**/api/v1/overview?*', (route) => route.fulfill({ json: overview }));
  await page.addInitScript('localStorage.setItem("binsight.currency", "usd")');
  let phase: 'initial' | 'failed' | 'recovered' = 'initial';
  await page.route('**/api/v1/stats/series?*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('currency')).toBe('usd');
    return phase === 'failed'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid' })
      : route.fulfill({ json: statsSeriesFixture('usd') });
  });
  await page.goto('/');
  const region = page.getByRole('region', { name: 'Real PnL', exact: true });
  await expect(region.getByRole('slider')).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(31_000);
  phase = 'failed';
  await page.evaluate('window.dispatchEvent(new Event("visibilitychange"))');
  await expect(region.getByRole('alert')).toContainText('Something went wrong');
  await expect(region.getByText('Showing previous readings.')).toBeVisible();
  await focusChartWithKeyboard(page);
  await page.keyboard.press('Home');
  await expect(region.getByRole('slider')).toHaveAttribute(
    'aria-valuetext',
    /Profit: plus \$1.00.*plus 2.41%.*Cumulative: plus \$1.00.*plus 20.40%/,
  );
  await page.screenshot({
    path: `test-results/visual/${testInfo.project.name}/overview-pulse-refetch-usd.png`,
    fullPage: !testInfo.project.name.startsWith('mobile'),
  });
  await expectNoA11yViolations(page);
  await page.keyboard.press('.');
  await expect(region.getByRole('slider')).toHaveAttribute(
    'aria-valuetext',
    /amount hidden USD.*plus 20.40%/,
  );
  await expect(region.getByRole('table')).not.toContainText('$1.00');
  await expectNoA11yViolations(page);
  phase = 'recovered';
  await page.keyboard.press('Escape');
  await region.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveCount(0);
});
