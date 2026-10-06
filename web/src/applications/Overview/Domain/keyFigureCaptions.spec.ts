import {
  gainImports,
  hasNoOpenPositions,
  todayCaption,
} from '@app/applications/Overview/Domain/keyFigureCaptions';
import { describe, expect, it } from 'vitest';

const complete = { exactness: 'complete' as const };
const unavailable = { exactness: 'unavailable' as const };
const importing = {
  exactness: 'unavailable' as const,
  reasons: [{ code: 'history_incomplete' }],
};

describe('todayCaption', () => {
  it('counts the closes when there are some', () => {
    expect(todayCaption({ count: 5, pnl: complete })).toBe('closes');
  });

  it('says nothing closed only when the server proves a complete zero day', () => {
    expect(todayCaption({ count: 0, pnl: complete })).toBe('nothing-closed');
  });

  it('gives the reasons instead of claiming no closes while the figure is unavailable', () => {
    expect(todayCaption({ count: 0, pnl: unavailable })).toBe('reasons');
  });
});

describe('hasNoOpenPositions', () => {
  it('says no open positions only on a complete zero', () => {
    expect(hasNoOpenPositions({ count: 0, pnl: complete })).toBe(true);
    expect(hasNoOpenPositions({ count: 0, pnl: unavailable })).toBe(false);
    expect(hasNoOpenPositions({ count: 2, pnl: complete })).toBe(false);
  });
});

describe('gainImports', () => {
  it('names the importing wallets only when an import keeps the gain unavailable', () => {
    expect(gainImports(importing, ['Cold'])).toEqual(['Cold']);
    expect(gainImports({ exactness: 'unavailable', reasons: [] }, ['Cold'])).toEqual([]);
    expect(gainImports(complete, ['Cold'])).toEqual([]);
  });
});
