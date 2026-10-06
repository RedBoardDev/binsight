import { expect, type Page } from '@playwright/test';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

const openChart = async (page: Page) => {
  await page.goto('/test/harness/');
  const slider = page.getByRole('slider', { name: 'Real PnL sample' });
  await expect(slider).toBeVisible();
  await slider.scrollIntoViewIfNeeded();
  await page.evaluate('document.fonts.ready');
  await page.evaluate(
    `document.querySelector('figure[aria-label="Real PnL sample"]').scrollIntoView({block: "center"})`,
  );
  await expect
    .poll(async () => page.evaluate<number>('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(testViewportWidth(page));
  return slider;
};

const testViewportWidth = (page: Page): number => page.viewportSize()?.width ?? 0;

test('shows the pulse, its keyboard readout and masked accessible values', async ({
  page,
}, testInfo) => {
  const slider = await openChart(page);
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /Profit: plus 0.422 SOL.*vs net worth: plus 0.70%.*Cumulative: plus 0.422 SOL.*vs net worth: plus 0.70%/,
  );
  await expect(slider).toHaveCSS('outline-style', 'solid');
  await expect(slider).toHaveCSS('outline-width', '2px');
  await expect(
    page.locator('figure[aria-label="Real PnL sample"] svg[role="img"] > line'),
  ).not.toHaveCSS('stroke', 'none');
  await expect(page.locator('figure[aria-label="Real PnL sample"] pattern')).toHaveCount(0);
  await expect(page.locator('figure[aria-label="Real PnL sample"] circle')).not.toHaveCSS(
    'stroke',
    'none',
  );
  const chart = page.getByRole('figure', { name: 'Real PnL sample' });
  await chart.screenshot({ path: `test-results/visual/${testInfo.project.name}/pulse-chart.png` });
  await expectNoA11yViolations(page);
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', /Profit: minus 0.210 SOL/);
  await page.keyboard.press('.');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /Profit: minus amount hidden SOL.*vs net worth: minus 0.35%/,
  );
  const table = page.getByRole('table', { name: 'Real PnL sample' });
  await expect(table).toContainText('amount hidden SOL');
  await expect(table).not.toContainText('0.422');
  await chart.screenshot({
    path: `test-results/visual/${testInfo.project.name}/pulse-chart-hidden.png`,
  });
});

test('scrubs a real touch only after horizontal movement and releases it', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'touch scrubbing is checked on phones');
  const slider = await openChart(page);
  const box = await slider.boundingBox();
  if (box === null) throw new Error('the chart has no pointer bounds');
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width * 0.25;
  const y = box.y + box.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + 5, y }],
  });
  await expect(page.getByText('Daily', { exact: true })).toBeVisible();
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + 35, y }],
  });
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  await expect(slider).toHaveAttribute('aria-valuetext', /estimated/);
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.getByText('Daily', { exact: true })).toBeVisible();
  await session.detach();
});

test('keeps native vertical scrolling after a touch gesture is cancelled', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith('mobile'),
    'native touch scrolling is checked on phones',
  );
  const slider = await openChart(page);
  const session = await page.context().newCDPSession(page);
  for (let gesture = 0; gesture < 2; gesture += 1) {
    const box = await slider.boundingBox();
    if (box === null) throw new Error('the chart has no pointer bounds');
    const before = await page.evaluate<number>('window.scrollY');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const distance of [20, 45, 75]) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 2, y: y - distance }],
      });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => page.evaluate('window.scrollY')).toBeGreaterThan(before + 20);
    await expect(page.getByText('Daily', { exact: true })).toBeVisible();
  }
  await session.detach();
});
