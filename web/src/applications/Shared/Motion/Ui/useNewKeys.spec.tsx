import { useNewKeys } from '@app/applications/Shared/Motion/Ui/useNewKeys';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('useNewKeys', () => {
  it('finds nothing new on the first render', () => {
    const { result } = renderHook(() => useNewKeys(['a', 'b']));

    expect(result.current).toEqual(new Set());
  });

  it('finds the keys that arrived with the next version of the list', () => {
    const { result, rerender } = renderHook(({ keys }) => useNewKeys(keys), {
      initialProps: { keys: ['a', 'b'] },
    });

    rerender({ keys: ['c', 'a', 'b'] });

    expect(result.current).toEqual(new Set(['c']));
  });

  it('keeps the answer while the list does not change', () => {
    const keys = ['a', 'b'];
    const { result, rerender } = renderHook(({ list }) => useNewKeys(list), {
      initialProps: { list: ['a'] },
    });
    rerender({ list: keys });
    rerender({ list: keys });

    expect(result.current).toEqual(new Set(['b']));
  });

  it('accepts keys derived in render, a new array on every render', () => {
    const { result, rerender } = renderHook(({ rows }) => useNewKeys(rows.map((row) => row.id)), {
      initialProps: { rows: [{ id: 'a' }] },
    });
    rerender({ rows: [{ id: 'a' }] });
    rerender({ rows: [{ id: 'b' }, { id: 'a' }] });
    rerender({ rows: [{ id: 'b' }, { id: 'a' }] });

    expect(result.current).toEqual(new Set(['b']));
  });
});
