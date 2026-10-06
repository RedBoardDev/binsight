import { expect } from '@playwright/test';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

test('draws compressed bins and reads every source with the keyboard and hidden mode', async ({
  page,
}, testInfo) => {
  await page.goto('/test/harness/');
  const figure = page.getByRole('figure', { name: 'Liquidity bins sample' });
  const slider = page.getByRole('slider', { name: 'Liquidity bins sample' });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveCSS('height', '72px');
  const quietBar = page.locator('[data-bin-variant="out-quiet"] rect').first();
  const normalBar = page.locator('[data-bin-variant="out-normal"] rect').first();
  await expect(quietBar).toHaveCSS('opacity', '0.35');
  await expect(normalBar).toHaveCSS('opacity', '0.4');
  const warningFill = await page.evaluate<string>(
    `getComputedStyle(document.querySelector('[data-bin-variant="out-quiet"] rect')).fill`,
  );
  await expect(normalBar).not.toHaveCSS('fill', warningFill);
  await expect(page.locator('[data-bin-variant="out-normal"] line').last()).toHaveCSS(
    'stroke',
    warningFill,
  );
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /Server group beginning at bin 0:.*Server group beginning at bin 3:/,
  );
  const bars = figure.locator('svg rect');
  expect(await bars.count()).toBeLessThanOrEqual(44);
  expect(await bars.count()).toBeGreaterThan(0);
  await expect(bars.first()).not.toHaveCSS('fill', 'none');
  await expect(figure.locator('linearGradient stop').first()).not.toHaveCSS(
    'stop-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(figure.locator('svg line').last()).not.toHaveCSS('stroke', 'none');
  await expect(slider).toHaveCSS('outline-style', 'solid');
  await expect(slider).toHaveCSS('outline-width', '2px');
  await page.evaluate(
    `document.querySelector('figure[aria-label="Liquidity bins sample"]').scrollIntoView({block:"center"})`,
  );
  await expect
    .poll(async () => page.evaluate<number>('document.documentElement.scrollWidth'))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await figure.screenshot({
    path: `test-results/visual/${testInfo.project.name}/bin-histogram.png`,
  });
  await expectNoA11yViolations(page);
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', /Server group beginning at bin 207:/);
  await page.keyboard.press('.');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /first-bin price amount hidden SOL; base amount hidden token; quote amount hidden SOL/,
  );
  const table = page.getByRole('table', { name: 'Liquidity bins sample' });
  await expect(table).toContainText('amount hidden');
  await expect(table).not.toContainText('9007.2T');
  await expect(figure).toContainText('10.6% wide');
  await figure.screenshot({
    path: `test-results/visual/${testInfo.project.name}/bin-histogram-hidden.png`,
  });
});
