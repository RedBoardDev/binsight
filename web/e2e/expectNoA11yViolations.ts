import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

export const expectNoA11yViolations = async (page: Page): Promise<void> => {
  // react-aria's live announcer keeps, for a few seconds, messages labelled by elements of the
  // page that announced them; after a navigation they point at nothing and axe reports them.
  const { violations } = await new AxeBuilder({ page }).exclude('[data-live-announcer]').analyze();
  const blocking = violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => {
      const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
      return `${violation.id}: ${violation.help} (${targets})`;
    });
  expect(blocking).toEqual([]);
};
