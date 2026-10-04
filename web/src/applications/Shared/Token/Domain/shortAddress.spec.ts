import { shortAddress } from '@app/applications/Shared/Token/Domain/shortAddress';
import { describe, expect, it } from 'vitest';

describe('shortAddress', () => {
  it('keeps the first and last four characters', () => {
    expect(shortAddress('EdfeJhR3pW8VZy1oxKq7bS9cTn2mLu4AvG6sWx5Pfegz')).toBe('Edfe…fegz');
  });

  it('leaves a short value as it is', () => {
    expect(shortAddress('abc')).toBe('abc');
    expect(shortAddress('abcdefghi')).toBe('abcdefghi');
  });
});
