import type { ApiSchema } from '@app/lib/api/apiSchema';
import { describe, expect, expectTypeOf, it } from 'vitest';

type Figure = ApiSchema<'Figure'>;

const amountOf = (figure: Figure): string | null =>
  figure.exactness === 'unavailable' ? null : figure.value.amount;

describe('ApiSchema<"Figure">', () => {
  it('has a value only when it is not unavailable', () => {
    const complete: Figure = { exactness: 'complete', value: { amount: '1.5', unit: 'sol' } };
    const unavailable: Figure = { exactness: 'unavailable', reasons: [{ code: 'no_usd_rate' }] };

    expect(amountOf(complete)).toBe('1.5');
    expect(amountOf(unavailable)).toBeNull();
  });

  it('narrows on its exactness in the generated types', () => {
    expectTypeOf<Extract<Figure, { exactness: 'unavailable' }>>().not.toHaveProperty('value');
    expectTypeOf<Extract<Figure, { exactness: 'complete' }>>().toHaveProperty('value');
  });
});
