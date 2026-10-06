import { readFileSync } from 'node:fs';
import { isDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const contract = z
  .object({
    components: z.object({
      schemas: z.object({ DecimalString: z.object({ pattern: z.string() }) }),
    }),
  })
  .parse(JSON.parse(readFileSync(new URL('../../openapi/v1.json', import.meta.url), 'utf8')));
const pattern = new RegExp(contract.components.schemas.DecimalString.pattern);

describe('the generated canonical decimal contract', () => {
  it.each([
    '0',
    '1',
    '-1',
    '0.1',
    '-0.1',
    '0.001',
    '-0.0001',
    '123.04',
    '-123.04',
    '170141183460469231731687303715884105727',
    '-170141183460469231731687303715884105728',
    '-0.000000000000000000000000000001',
  ])('allows the canonical string %s at both boundaries', (amount) => {
    expect(pattern.test(amount)).toBe(true);
    expect(isDecimalString(amount)).toBe(true);
  });

  it.each([
    '-0',
    '-0.0',
    '0.0',
    '1.00',
    '00',
    '01',
    '+1',
    '1e2',
    '.1',
    '1.',
    '-00',
    '-01',
    '',
    ' 1',
    '1 ',
    '0\n',
    '-1\r\n',
  ])('rejects the noncanonical string %s at both boundaries', (amount) => {
    expect(pattern.test(amount)).toBe(false);
    expect(isDecimalString(amount)).toBe(false);
  });
});
