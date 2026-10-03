import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

export const expectNoA11yViolations = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`);
  expect(blocking).toEqual([]);
};
