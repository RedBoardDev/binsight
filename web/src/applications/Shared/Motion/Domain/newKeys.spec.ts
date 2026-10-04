import { findNewKeys, haveSameKeys } from '@app/applications/Shared/Motion/Domain/newKeys';
import { describe, expect, it } from 'vitest';

describe('findNewKeys', () => {
  it('finds the keys that were not there before', () => {
    expect(findNewKeys(['a', 'b'], ['c', 'a', 'b', 'd'])).toEqual(new Set(['c', 'd']));
  });

  it('ignores keys that left the list', () => {
    expect(findNewKeys(['a', 'b'], ['b'])).toEqual(new Set());
  });
});

describe('haveSameKeys', () => {
  it('compares two lists by their keys, in order', () => {
    expect(haveSameKeys(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(haveSameKeys(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(haveSameKeys(['a'], ['a', 'b'])).toBe(false);
  });
});
