import type { Browser, Page } from '@playwright/test';
import {
  type CaptureScenario,
  type CaptureStep,
  PARITY_NOW,
  type ThemeName,
  VIEWPORTS,
  type ViewportName,
} from './parityScenarios';

export interface CaptureTarget {
  readonly baseURL: string;
  readonly scenario: CaptureScenario;
  readonly viewport: ViewportName;
  readonly theme: ThemeName;
  readonly storageState?: string;
  readonly localStorage?: Readonly<Record<string, string>>;
}

const READY_TIMEOUT_MS = 30_000;

// Nothing moves any more: no finite animation runs and no placeholder is left (a looping one, such
// as a pulsing dot, never ends; reduced motion stops the app's own). Strings, not functions: this
// file is typed for Node, which has no document.
const SETTLED = `document.fonts.status === 'loaded'
  && document.getAnimations().every((animation) => animation.playState !== 'running'
    || animation.effect?.getTiming().iterations === Infinity)
  && document.querySelectorAll('.skeleton, [role="status"][aria-label^="Loading"]').length === 0`;

const waitUntilSettled = async (page: Page): Promise<void> => {
  await page.waitForFunction(SETTLED, undefined, { timeout: READY_TIMEOUT_MS });
  // Two frames: what the last state change asked for is painted.
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
};

const runStep = async (page: Page, step: CaptureStep): Promise<void> => {
  if ('click' in step) await page.locator(step.click).first().click();
  else if ('hover' in step) await page.locator(step.hover).first().hover();
  else if ('press' in step) await page.keyboard.press(step.press);
  else if ('scroll' in step) await page.evaluate(`window.scrollTo(0, ${step.scroll})`);
  else {
    const box = await page.locator(step.pointer.selector).first().boundingBox();
    if (box === null) throw new Error(`${step.pointer.selector} is not on the screen`);
    await page.mouse.move(box.x + box.width * step.pointer.x, box.y + box.height * step.pointer.y);
  }
};

// One screenshot of one side: a fresh context per shot, the clock frozen at the demo's instant,
// the system theme as asked. The shot waits for the scenario's positive "ready" signs, then for
// the page to settle, never for a fixed pause.
export const captureScreen = async (browser: Browser, target: CaptureTarget): Promise<Buffer> => {
  const isPhone = target.viewport === 'mobile';
  const context = await browser.newContext({
    baseURL: target.baseURL,
    viewport: VIEWPORTS[target.viewport],
    deviceScaleFactor: 1,
    isMobile: isPhone,
    hasTouch: isPhone,
    colorScheme: target.theme,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    ...(target.storageState === undefined ? {} : { storageState: target.storageState }),
  });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(PARITY_NOW));
    if (target.localStorage !== undefined) {
      // A string: this file is typed for Node, which has no window.
      await page.addInitScript(
        `for (const [key, value] of Object.entries(${JSON.stringify(target.localStorage)})) localStorage.setItem(key, value);`,
      );
    }
    await page.goto(target.scenario.path);
    for (const ready of target.scenario.ready) {
      await page.locator(ready).first().waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
    }
    await waitUntilSettled(page);
    for (const step of target.scenario.steps ?? []) {
      await runStep(page, step);
      await waitUntilSettled(page);
    }
    return await page.screenshot({ fullPage: target.scenario.fullPage === true });
  } finally {
    await context.close();
  }
};
