import { expect } from '@playwright/test';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

test('scrubs the net worth server readings and masks amounts in speech and the equivalent table', async ({
  page,
}, testInfo) => {
  await page.goto('/design');
  const figure = page.getByRole('figure', { name: 'Net worth sample' });
  const slider = page.getByRole('slider', { name: 'Net worth sample' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', /Net worth: 100.*SOL/);
  await expect(slider).toHaveCSS('outline-width', '2px');
  await expect(slider).toHaveCSS('outline-style', 'solid');
  await expect(figure.locator('svg path').first()).not.toHaveCSS('stroke', 'none');
  await expect(figure.locator('svg path[stroke-dasharray]').first()).toHaveAttribute(
    'stroke-dasharray',
    '4 4',
  );
  await page.evaluate(
    `document.querySelector('figure[aria-label="Net worth sample"]').scrollIntoView({block:"center"})`,
  );
  await figure.screenshot({
    path: `test-results/visual/${testInfo.project.name}/net-worth-line.png`,
  });
  const box = await slider.boundingBox();
  if (box === null) throw new Error('The line has no pointer bounds');
  await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
  await expect(slider).toHaveAttribute('aria-valuenow', '5');
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', /Net worth: 110.*SOL/);
  await page.keyboard.press('.');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /Net worth: amount hidden SOL; Period change: \+10%/,
  );
  await expect(page.getByRole('table', { name: 'Net worth sample' })).toContainText(
    'amount hidden',
  );
  await expect(figure).toContainText('+10%');
  await expect
    .poll(async () => page.evaluate<number>('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await figure.screenshot({
    path: `test-results/visual/${testInfo.project.name}/net-worth-line-hidden.png`,
  });
  await expectNoA11yViolations(page);
});

test('draws neutral billing-cycle days across months and keeps credit readings visible in hidden mode', async ({
  page,
}, testInfo) => {
  await page.goto('/design');
  const figure = page.getByRole('figure', { name: 'Billing cycle credits sample' });
  const slider = page.getByRole('slider', { name: 'Billing cycle credits sample' });
  await page.evaluate('document.fonts.ready');
  await slider.scrollIntoViewIfNeeded();
  await expect(slider).toBeInViewport();
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', /Oct 17: 230 credits; daily budget 650/);
  const bars = figure.locator('svg rect');
  await expect(bars).toHaveCount(10);
  const dates = figure.locator('svg text');
  for (let index = 1; index < (await dates.count()); index += 1) {
    const previous = await dates.nth(index - 1).boundingBox();
    const current = await dates.nth(index).boundingBox();
    if (previous === null || current === null)
      throw new Error('An axis label has no drawing bounds');
    expect(current.x - previous.x - previous.width).toBeGreaterThanOrEqual(8);
  }
  const mutedFill = await page.evaluate<string>(
    `getComputedStyle(document.querySelector('figure[aria-label="Billing cycle credits sample"] rect')).fill`,
  );
  await expect(bars.last()).not.toHaveCSS('fill', mutedFill);
  await expect(figure.locator('svg line[stroke-dasharray]')).not.toHaveCSS('stroke', 'none');
  await bars.nth(8).scrollIntoViewIfNeeded();
  await expect(bars.nth(8)).toBeInViewport();
  const november = await bars.nth(8).boundingBox();
  if (november === null) throw new Error('The November day has no pointer bounds');
  await page.mouse.move(november.x + november.width / 2, november.y + november.height / 2);
  await expect(slider).toHaveAttribute('aria-valuetext', /Nov 1: 620 credits/);
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', /Nov 2: 320 credits/);
  await page.keyboard.press('.');
  await expect(slider).toHaveAttribute('aria-valuetext', /Nov 2: 320 credits/);
  await expect(
    page.getByRole('table', { name: 'Billing cycle credits sample' }).getByRole('row'),
  ).toHaveCount(11);
  await expect(
    page.getByRole('figure', { name: 'Generic credit stacks sample' }).locator('svg rect'),
  ).toHaveCount(40);
  await page.evaluate(
    `document.querySelector('figure[aria-label="Billing cycle credits sample"]').scrollIntoView({block:"center"})`,
  );
  await figure.screenshot({
    path: `test-results/visual/${testInfo.project.name}/billing-cycle-credits.png`,
  });
  await page.getByRole('figure', { name: 'Generic credit stacks sample' }).screenshot({
    path: `test-results/visual/${testInfo.project.name}/generic-credit-stacks.png`,
  });
  await expect(slider).toHaveCSS('outline-width', '2px');
  await expectNoA11yViolations(page);
});

test('starts line and credit touch scrubbing after the horizontal threshold and restores vertical scrolling', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith('mobile'),
    'Native touch gestures are checked on phones',
  );
  for (const label of ['Net worth sample', 'Billing cycle credits sample']) {
    await page.goto('/design');
    const figure = page.getByRole('figure', { name: label });
    const slider = page.getByRole('slider', { name: label });
    await expect(slider).toBeVisible();
    await page.evaluate(
      `document.querySelector('figure[aria-label="${label}"]').scrollIntoView({block:"center"})`,
    );
    const box = await slider.boundingBox();
    if (box === null) throw new Error('The chart has no touch bounds');
    const session = await page.context().newCDPSession(page);
    const x = box.x + box.width / 4;
    const y = box.y + box.height / 2;
    const caption = figure.locator('figcaption');
    const initial = await caption.textContent();
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 5, y }],
    });
    await expect(caption).toHaveText(initial ?? '');
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 35, y }],
    });
    await expect(caption).not.toHaveText(initial ?? '');
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(caption).toHaveText(initial ?? '');
    const before = await page.evaluate<number>('window.scrollY');
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const distance of [20, 45, 75]) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 2, y: y - distance }],
      });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect
      .poll(async () => page.evaluate<number>('window.scrollY'))
      .toBeGreaterThan(before + 20);
    await expect(caption).toHaveText(initial ?? '');
    await session.detach();
  }
});
