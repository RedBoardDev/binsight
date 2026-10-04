import { summarizeSelection } from '@app/applications/Shared/Control/Domain/selectionSummary';
import { describe, expect, it } from 'vitest';

describe('summarizeSelection', () => {
  it('reads an empty choice as no filter', () => {
    expect(summarizeSelection([], 'en')).toEqual({ kind: 'everything' });
  });

  it('names one or two choices', () => {
    expect(summarizeSelection(['Spot'], 'en')).toEqual({ kind: 'named', text: 'Spot' });
    expect(summarizeSelection(['Spot', 'Curve'], 'en')).toEqual({
      kind: 'named',
      text: 'Spot, Curve',
    });
  });

  it('joins two choices the way the language does', () => {
    expect(summarizeSelection(['Spot', 'Curve'], 'de')).toEqual({
      kind: 'named',
      text: 'Spot und Curve',
    });
  });

  it('names the first of more and counts the others', () => {
    expect(summarizeSelection(['Spot', 'Curve', 'Bid-Ask'], 'en')).toEqual({
      kind: 'counted',
      first: 'Spot',
      others: 2,
    });
  });
});
