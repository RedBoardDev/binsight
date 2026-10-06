import { expect } from '@playwright/test';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

test('draws lazy position candles with exact server readouts, range labels and TradingView attribution', async ({
  page,
}, testInfo) => {
  await page.goto('/test/harness/');
  const figure = page.getByRole('figure', { name: 'Position candles sample', exact: true });
  const slider = page.getByRole('slider', { name: 'Position candles sample', exact: true });
  await expect(figure.locator('canvas').first()).toBeVisible();
  await expect(figure.locator('#tv-attr-logo')).toBeVisible();
  await expect(figure.locator('#tv-attr-logo')).toHaveAttribute(
    'href',
    /https:\/\/www.tradingview.com\//,
  );
  const interval = figure.getByRole('radio', { name: '5m', exact: true });
  await interval.focus();
  for (
    let step = 0;
    step < 8 &&
    !(await page.evaluate<boolean>('document.activeElement?.getAttribute("role") === "slider"'));
    step++
  )
    await page.keyboard.press('Tab');
  await expect(slider).toBeFocused();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', /Open: 0\.0000000011/);
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await expect(slider).toHaveCSS('outline-width', '2px');
  await expect(
    page.getByRole('table', { name: 'Position candles sample', exact: true }).getByRole('row'),
  ).toHaveCount(49);
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', /Closing price: 0\.000000001378/);
  const reading = await slider.getAttribute('aria-valuetext');
  await page.keyboard.press('.');
  await expect(slider).toHaveAttribute('aria-valuetext', reading ?? '');
  await page
    .context()
    .route('https://www.tradingview.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Attribution link fixture</title>' }),
    );
  const [attribution] = await Promise.all([
    page.waitForEvent('popup'),
    figure.locator('#tv-attr-logo').click(),
  ]);
  await expect(attribution).toHaveURL(/https:\/\/www.tradingview.com\//);
  await attribution.close();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The visual fixture needs a viewport');
  await page.setViewportSize({ ...viewport, width: viewport.width - 40 });
  await page.setViewportSize(viewport);
  // Inspect the real SDK's painted bodies: a resize must not leave most of the period blank.
  await expect
    .poll(() =>
      page.evaluate<number>(`(() => {
    const figure = document.querySelector('figure[aria-label="Position candles sample"]');
    const canvas = figure.querySelector('canvas');
    const colors = ['--gain', '--loss'].map(token => {
      const color = getComputedStyle(figure).getPropertyValue(token).trim().slice(1);
      return [0, 2, 4].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    });
    const {data} = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let first = canvas.width;
    let last = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] !== 255 || !colors.some(color => color.every((part, index) => part === data[offset + index]))) continue;
      const x = (offset / 4) % canvas.width;
      first = Math.min(first, x);
      last = Math.max(last, x);
    }
    return (last - first) / canvas.width;
  })()`),
    )
    .toBeGreaterThan(0.7);
  await page.evaluate(
    `document.querySelector('figure[aria-label="Position candles sample"]').scrollIntoView({block:"center"})`,
  );
  await figure.screenshot({
    path: `test-results/visual/${testInfo.project.name}/position-candles.png`,
  });
  const closed = page.getByRole('figure', { name: 'Closed position candles sample' });
  await expect(closed.locator('canvas').first()).toBeVisible();
  await page.mouse.move(0, 0);
  await page.evaluate(
    `document.querySelector('figure[aria-label="Closed position candles sample"]').scrollIntoView({block:"center"})`,
  );
  await expect
    .poll(() =>
      page.evaluate<number>(`(() => {
    const figure = document.querySelector('figure[aria-label="Closed position candles sample"]');
    const canvas = figure.querySelector('canvas');
    const color = getComputedStyle(figure).getPropertyValue('--muted').trim().slice(1);
    const rgb = [0, 2, 4].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    const {data} = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const counts = Array(canvas.width).fill(0);
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] < 40 || !rgb.every((part, index) => Math.abs(part - data[offset + index]) <= 2)) continue;
      counts[(offset / 4) % canvas.width] += 1;
    }
    const highest = Math.max(...counts);
    return highest > canvas.height * 0.2 ? counts.indexOf(highest) / canvas.width : -1;
  })()`),
    )
    .toBeGreaterThan(0.75);
  await closed.screenshot({
    path: `test-results/visual/${testInfo.project.name}/closed-position-candles.png`,
  });
  await expect
    .poll(() => page.evaluate<number>('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await expectNoA11yViolations(page);
});

test('moves the crosshair, changes intervals and reapplies the theme without replacing its canvases', async ({
  page,
}) => {
  await page.goto('/test/harness/');
  const figure = page.getByRole('figure', { name: 'Position candles sample', exact: true });
  const slider = page.getByRole('slider', { name: 'Position candles sample', exact: true });
  await expect(figure.locator('canvas').first()).toBeVisible();
  await page.evaluate(
    `document.querySelector('figure[aria-label="Position candles sample"]').scrollIntoView({block:"center"})`,
  );
  await slider.focus();
  await page.keyboard.press('Home');
  const box = await slider.boundingBox();
  if (box === null) throw new Error('The candle chart has no drawing bounds');
  await page.mouse.move(box.x + (box.width - 90) * 0.65, box.y + box.height / 2);
  await expect.poll(() => slider.getAttribute('aria-valuenow')).not.toBe('0');
  await page.evaluate(
    `window.binsightCandleCanvas = document.querySelector('figure[aria-label="Position candles sample"] canvas')`,
  );
  await figure.getByRole('radio', { name: '1h', exact: true }).click();
  await expect(figure.getByRole('radio', { name: '1h', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(await page.evaluate<boolean>('window.binsightCandleCanvas.isConnected')).toBe(true);
  const theme = await page.evaluate<string>('document.documentElement.dataset.theme');
  const next = theme === 'dark' ? 'light' : 'dark';
  await page.evaluate(
    `import('/src/core/theme/themeStore.ts').then(module => module.themeStore.setPreference('${next}'))`,
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  expect(await page.evaluate<boolean>('window.binsightCandleCanvas.isConnected')).toBe(true);
  await expect(figure.locator('#tv-attr-logo')).toBeVisible();
});

test('allows vertical scrolling on the candle surface after a native touch gesture', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Native touch is checked on phones');
  await page.goto('/test/harness/');
  const slider = page.getByRole('slider', { name: 'Position candles sample', exact: true });
  await expect(
    page
      .getByRole('figure', { name: 'Position candles sample', exact: true })
      .locator('canvas')
      .first(),
  ).toBeVisible();
  await page.evaluate(
    `document.querySelector('figure[aria-label="Position candles sample"]').scrollIntoView({block:"center"})`,
  );
  const box = await slider.boundingBox();
  if (box === null) throw new Error('The candle chart has no touch bounds');
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const before = await page.evaluate<number>('window.scrollY');
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const distance of [20, 45, 75])
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 2, y: y - distance }],
    });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate<number>('window.scrollY')).toBeGreaterThan(before + 20);
  await session.detach();
});

test('links a native event-marker hover to the caller timeline and accepts the inverse highlight', async ({
  page,
}) => {
  await page.goto('/test/harness/');
  const figure = page.getByRole('figure', { name: 'Position candles sample', exact: true });
  const canvas = figure.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.evaluate(
    `document.querySelector('figure[aria-label="Position candles sample"]').scrollIntoView({block:"center"})`,
  );
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error('The event marker has no native canvas');
  const claim = page.getByRole('button', { name: 'claim', exact: true });
  // The unpriced claim marker is decorative at y=22; find its real hit area without inventing a price.
  for (let x = bounds.x + 8; x < bounds.x + bounds.width - 8; x += 4) {
    await page.mouse.move(x, bounds.y + 22);
    await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    if ((await claim.getAttribute('aria-pressed')) === 'true') break;
  }
  await expect(claim).toHaveAttribute('aria-pressed', 'true');
  const rebalance = page.getByRole('button', { name: 'rebalance', exact: true });
  await rebalance.hover();
  await expect(rebalance).toHaveAttribute('aria-pressed', 'true');
});
