import { safeRedirect } from '@app/applications/Auth/Domain/safeRedirect';
import { describe, expect, it } from 'vitest';

describe('safeRedirect', () => {
  it('keeps a path of this site, with its search and hash', () => {
    expect(safeRedirect('/positions?wallet=main#open')).toBe('/positions?wallet=main#open');
  });

  it('goes to the dashboard when there is no destination', () => {
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect('')).toBe('/');
  });

  it('refuses a destination on another site', () => {
    expect(safeRedirect('https://evil.example/')).toBe('/');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('/\\evil.example')).toBe('/');
    expect(safeRedirect('/\t/evil.example')).toBe('/');
    expect(safeRedirect('javascript:alert(1)')).toBe('/');
  });

  it('never sends the owner back to the login page', () => {
    expect(safeRedirect('/login')).toBe('/');
    expect(safeRedirect('/login?redirect=/positions')).toBe('/');
    expect(safeRedirect('/login-help')).toBe('/login-help');
  });
});
