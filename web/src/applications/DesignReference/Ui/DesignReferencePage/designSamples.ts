import {
  type DecimalString,
  parseDecimalString,
} from '@app/applications/Shared/Figure/Domain/decimalString';
import type {
  Figure,
  MoneyUnit,
  PercentFigure,
  Price,
} from '@app/applications/Shared/Figure/Domain/figure';

const sample = (value: string): DecimalString => {
  const parsed = parseDecimalString(value);
  if (parsed === null) {
    throw new Error(`the sample ${value} is not a decimal string`);
  }
  return parsed;
};

const complete = (amount: string, unit: MoneyUnit = 'sol'): Figure => ({
  exactness: 'complete',
  value: { amount: sample(amount), unit },
});

export const SAMPLE_AMOUNTS = {
  today: complete('0.4215'),
  loss: complete('-0.2104'),
  dust: complete('-0.0003'),
  netWorth: {
    exactness: 'partial',
    value: { amount: sample('61.541203117'), unit: 'sol' },
    reasons: [
      {
        code: 'unpriced_token',
        mint: 'sample-mint',
        wallet: 'sample-wallet',
      },
    ],
  },
  gain: {
    exactness: 'estimated',
    value: { amount: sample('14.6081'), unit: 'sol' },
    reasons: [
      { code: 'reconstructed_history', wallet: 'sample-wallet', until: '2026-09-01T00:00:00Z' },
    ],
  },
  unavailable: {
    exactness: 'unavailable',
    reasons: [{ code: 'history_incomplete', wallet: 'sample-wallet', progress: sample('32') }],
  },
  large: complete('1234.5678'),
  dollars: complete('-12.48', 'usd'),
  cents: complete('0.004321', 'usd'),
  stablecoin: complete('25.5', 'usdc'),
} as const satisfies Record<string, Figure>;

export const SAMPLE_PERCENTS = {
  gain: { exactness: 'complete', value: sample('2.5') },
  loss: { exactness: 'complete', value: sample('-4.984') },
  huge: { exactness: 'complete', value: sample('1234.5') },
} as const satisfies Record<string, PercentFigure>;

export const SAMPLE_PRICES = {
  ordinary: { amount: sample('148.2149'), quote: 'sol' },
  tiny: { amount: sample('0.0000221'), quote: 'sol' },
} as const satisfies Record<string, Price>;

export const SAMPLE_TOKEN_QUANTITY = sample('12400000');

export const SAMPLE_LIVE_VALUES = [sample('0.4215'), sample('0.4302'), sample('0.4291')] as const;
