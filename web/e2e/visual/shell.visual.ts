import { expect, type Page, type TestInfo } from '@playwright/test';
import { expectNoA11yViolations } from '../expectNoA11yViolations';
import { test } from '../visualTest';

const SCREENSHOT_DIR = 'test-results/visual';
// A route opened for the first time is compiled on demand by the dev server.
const FIRST_LOAD_TIMEOUT_MS = 15_000;

const settle = async (page: Page): Promise<void> => {
  // A string, not a function: this file is typed for Node, which has no document.
  await page.evaluate('document.fonts.ready');
  await expect(page.getByRole('status').filter({ hasText: 'Live updates:' })).toHaveText(
    'Live updates: Live',
  );
};

const isPhone = (testInfo: TestInfo): boolean => testInfo.project.name.startsWith('mobile');

// A phone shot is the screen as seen: in a full-page shot, the fixed tab bar would float halfway
// down the page.
const shoot = async (page: Page, name: string, testInfo: TestInfo): Promise<void> => {
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${testInfo.project.name}/${name}.png`,
    fullPage: !isPhone(testInfo),
  });
};

const PAGES = [
  { name: 'overview', path: '/', heading: 'Overview' },
  { name: 'settings', path: '/settings', heading: 'Settings' },
] as const;

for (const { name, path, heading } of PAGES) {
  test(`shows the ${name} page`, async ({ page }, testInfo) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible({
      timeout: FIRST_LOAD_TIMEOUT_MS,
    });
    await settle(page);

    await shoot(page, name, testInfo);
    await expectNoA11yViolations(page);
  });
}

test('opens the account menu on a desktop and the More sheet on a phone', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await settle(page);

  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Settings and session' }).click();
    await expect(page.getByRole('menu', { name: 'Settings and session' })).toBeVisible();
  }

  await shoot(page, isPhone(testInfo) ? 'more-sheet' : 'account-menu', testInfo);
  await expectNoA11yViolations(page);
});

test('shrinks the tab bar to a disc on a quick scroll down', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'the tab bar exists on phones only');
  // The bar never shrinks with reduced motion, which the other shots ask for.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // A short screen, so that Settings scrolls.
  await page.setViewportSize({ width: 390, height: 520 });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({
    timeout: FIRST_LOAD_TIMEOUT_MS,
  });
  await settle(page);

  await page.evaluate('window.scrollTo(0, 300)');
  const disc = page.getByRole('button', { name: 'Show the tabs' });
  await expect(disc).toBeVisible();
  await page.waitForFunction(
    "document.getAnimations().every((animation) => animation.playState !== 'running')",
  );
  await shoot(page, 'tab-bar-minimized', testInfo);

  await disc.click();
  await expect(page.getByRole('link', { name: 'History' })).toBeVisible();
});

test('opens figure reasons from the touch area beside the glyph', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'the extended touch area exists on coarse pointers only');
  await page.goto('/test/harness/');
  await expect(page.getByRole('heading', { name: 'Test harness' })).toBeVisible({
    timeout: FIRST_LOAD_TIMEOUT_MS,
  });
  await page.evaluate('document.fonts.ready');
  const trigger = page.getByRole('button', { name: 'Why a lower bound?', exact: true }).first();
  await trigger.scrollIntoViewIfNeeded();
  const box = await trigger.boundingBox();
  if (box === null) throw new Error('the figure reason trigger has no visible bounds');

  await page.touchscreen.tap(box.x - 8, box.y + box.height / 2);
  const dialog = page.getByRole('dialog', { name: 'Lower bound', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
