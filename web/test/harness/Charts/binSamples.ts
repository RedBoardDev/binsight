import type { BinChartSource } from '@app/applications/Shared/Chart/Domain/binBars';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Price } from '@app/applications/Shared/Figure/Domain/figure';

const decimal = (value: string) => {
  const parsed = parseDecimalString(value);
  if (parsed === null) throw new Error('A reference sample requires a canonical decimal');
  return parsed;
};

const heightSamples = ['0.3', '0.6', '0.8', '1', '0.6'] as const;

export const BIN_SAMPLES: BinChartSource = {
  active_bin_id: 104,
  lower_bin_id: 0,
  upper_bin_id: 209,
  bars: Array.from({ length: 70 }, (_, index) => ({
    bin_id: index * 3,
    base: index < 34 ? '0' : '9007199254740993.123456789',
    quote: index > 34 ? '0' : '0.000012345',
    height: heightSamples[index % heightSamples.length] ?? '1',
  })),
};

export const SAMPLE_BIN_PRICE: Price = { amount: decimal('0.000012345'), quote: 'sol' };
export const SAMPLE_LOWER_PRICE: Price = { amount: decimal('0.000009'), quote: 'sol' };
export const SAMPLE_UPPER_PRICE: Price = { amount: decimal('0.000016'), quote: 'sol' };
