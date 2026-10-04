import { renderAppAt } from '@test/renderAppAt';
import { signedInSession, stubApi } from '@test/stubApi';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

// Both navigations are in the DOM: CSS shows the top bar on a desktop and the tab bar on a phone.
const [TOP_BAR, TAB_BAR] = [0, 1];

const mainNavigations = (): HTMLElement[] => screen.getAllByRole('navigation', { name: 'Main' });

describe('AppShell', () => {
  it('marks the current page in both navigations', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/stats');
    await screen.findByRole('heading', { name: 'Stats' });

    for (const index of [TOP_BAR, TAB_BAR]) {
      const navigation = mainNavigations()[index];
      if (navigation === undefined) {
        throw new Error('a main navigation is missing');
      }
      expect(within(navigation).getByRole('link', { name: 'Stats' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(within(navigation).getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
        'aria-current',
      );
    }
  });

  it('opens the pages without a tab from "More"', async () => {
    const user = userEvent.setup();
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/');
    await screen.findByRole('heading', { name: 'Overview' });

    await user.click(screen.getByRole('button', { name: 'More' }));

    const sheet = await screen.findByRole('dialog', { name: 'More' });
    const rows = within(sheet)
      .getAllByRole('option')
      .map((row) => row.textContent);
    expect(rows).toEqual(['Wallets', 'Health', 'Settings', 'Sign out']);
  });

  it('lets the keyboard skip to the content', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/');
    await screen.findByRole('heading', { name: 'Overview' });

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'content');
  });

  it('names the tab after the page and focuses its title after a navigation', async () => {
    const user = userEvent.setup();
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/');
    await screen.findByRole('heading', { name: 'Overview' });

    const topBar = mainNavigations()[TOP_BAR];
    if (topBar === undefined) {
      throw new Error('the top bar navigation is missing');
    }
    await user.click(within(topBar).getByRole('link', { name: 'Stats' }));

    const title = await screen.findByRole('heading', { name: 'Stats' });
    await waitFor(() => expect(title).toHaveFocus());
    expect(document.title).toBe('Stats · binsight');
  });
});
