import { describe, expect, it } from 'vitest';
import { NAVIGATION_DENYLIST } from './navigationDenylist';

const isDenied = (path: string): boolean => NAVIGATION_DENYLIST.some((rule) => rule.test(path));

describe('NAVIGATION_DENYLIST', () => {
  it('leaves every API path to the network', () => {
    expect(isDenied('/api/v1/events')).toBe(true);
    expect(isDenied('/api/v1/health')).toBe(true);
  });

  it('leaves the license notices to the network', () => {
    expect(isDenied('/third-party-licenses.txt')).toBe(true);
  });

  it('serves the app shell for the pages of the app', () => {
    expect(isDenied('/')).toBe(false);
    expect(isDenied('/login')).toBe(false);
    expect(isDenied('/apiary')).toBe(false);
  });
});
