import { expect } from '@playwright/test';
import { statsSeriesFixture } from '../../test/fixtures/statsSeries';
import { test } from '../visualTest';

// Everything the reading draws stays inside it: a figure cut short reads as another figure.
const READING_OVERFLOW = `(() => {
  const caption = document.querySelector('figure figcaption');
  const box = caption.getBoundingClientRect();
  // Text for screen readers is a 1 px clipped box by design: it is not drawn.
  const drawn = [caption, ...caption.querySelectorAll('*')].filter(
    (element) => element.closest('.sr-only') === null,
  );
  return drawn.filter((element) => {
    const own = element.getBoundingClientRect();
    return element.scrollWidth > element.clientWidth + 0.5 || own.right > box.right + 0.5
      || own.left < box.left - 0.5 || box.right > document.documentElement.clientWidth;
  }).map((element) => element.textContent).slice(0, 3);
})()`;

test('reads a day in two reserved lines on a phone, never clipped, in English and German at 360 and 390 px', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'The phone reading is mobile only');
  const fixture = statsSeriesFixture();
  const long = fixture.points[1];
  if (long === undefined) throw new Error('The fixture needs a second point');
  const reasons = [
    {
      code: 'reconstructed_history' as const,
      wallet: 'test-wallet',
      until: '2026-10-01T00:00:00Z',
    },
  ];
  long.bar = { exactness: 'estimated', value: { amount: '-123.4567', unit: 'sol' }, reasons };
  long.bar_share_of_net_worth = { exactness: 'estimated', value: '-12.34', reasons };
  long.line = { exactness: 'estimated', value: { amount: '-1234.5678', unit: 'sol' }, reasons };
  long.line_share_of_net_worth = { exactness: 'estimated', value: '-123.45', reasons };
  await page.route('**/api/v1/stats/series?*', (route) => route.fulfill({ json: fixture }));
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const locale of ['en', 'de']) {
      await page.goto('/');
      await page.evaluate((language) => localStorage.setItem('binsight.locale', language), locale);
      await page.reload();
      const chart = page.getByRole('figure');
      const slider = chart.getByRole('slider');
      await expect(slider).toBeVisible();
      await page.evaluate('document.fonts.ready');
      const caption = await chart.locator('figcaption').boundingBox();
      const plot = await slider.boundingBox();
      const header = await page.locator('main section').first().boundingBox();
      if (caption === null || plot === null || header === null)
        throw new Error('The header and the chart need bounds');
      expect(plot.height).toBe(132);
      const session = await page.context().newCDPSession(page);
      const y = plot.y + plot.height / 2;
      for (const fraction of [0.05, 0.2, 0.5, 0.95]) {
        const x = plot.x + plot.width * fraction;
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y }],
        });
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x + (fraction > 0.5 ? -35 : 35), y }],
        });
        await expect(chart.getByRole('radiogroup')).toBeHidden();
        expect(await page.evaluate(READING_OVERFLOW)).toEqual([]);
        const reading = await chart.locator('figcaption').boundingBox();
        expect(reading?.height).toBe(caption.height);
        expect((await slider.boundingBox())?.y).toBe(plot.y);
        expect((await page.locator('main section').first().boundingBox())?.y).toBe(header.y);
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(chart.getByRole('radiogroup')).toBeVisible();
      }
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: plot.x + plot.width * 0.2, y }],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: plot.x + plot.width * 0.2 + 35, y }],
      });
      await page.screenshot({
        path: `test-results/visual/${testInfo.project.name}/overview-pulse-reading-${locale}-${width}.png`,
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    }
  }
});
