import { tokenInitials } from '@app/applications/Shared/Token/Domain/tokenInitials';
import { describe, expect, it } from 'vitest';

describe('tokenInitials', () => {
  it('keeps the first two letters of the symbol, in capitals', () => {
    expect(tokenInitials('WIF')).toBe('WI');
    expect(tokenInitials('jup')).toBe('JU');
  });

  it('skips the signs of a symbol', () => {
    expect(tokenInitials('$popcat')).toBe('PO');
  });

  it('keeps a one-letter symbol', () => {
    expect(tokenInitials('W')).toBe('W');
  });
});
