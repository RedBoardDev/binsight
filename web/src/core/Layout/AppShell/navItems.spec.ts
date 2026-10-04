import { activeTabFor } from '@app/core/Layout/AppShell/navItems';
import { describe, expect, it } from 'vitest';

describe('activeTabFor', () => {
  it('activates the tab of the page', () => {
    expect(activeTabFor('/')).toBe('/');
    expect(activeTabFor('/stats')).toBe('/stats');
  });

  it('activates "More" for the pages behind it', () => {
    expect(activeTabFor('/wallets')).toBe('more');
    expect(activeTabFor('/settings')).toBe('more');
  });

  it('activates nothing for an unknown address', () => {
    expect(activeTabFor('/does-not-exist')).toBeNull();
  });
});
