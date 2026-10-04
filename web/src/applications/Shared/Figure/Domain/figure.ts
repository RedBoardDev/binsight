import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';

// The figure shapes of the API contract (Money, Figure, PercentFigure, RatioFigure, Price). They
// mirror the planned contract until its endpoints are generated into the typed client; then they
// become aliases of the generated schemas.

export type MoneyUnit = 'sol' | 'usd' | 'usdc' | 'usdt';

export interface Money {
  readonly amount: DecimalString;
  readonly unit: MoneyUnit;
}

export type Exactness = 'complete' | 'partial' | 'estimated' | 'unavailable';

export interface TokenRef {
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
}

export type FigureReason =
  | {
      readonly code: 'unpriced_token';
      readonly token: TokenRef;
      readonly amount: DecimalString;
      readonly wallet: string;
    }
  | { readonly code: 'reconstructed_history'; readonly wallet: string; readonly until: string }
  | {
      readonly code: 'history_incomplete';
      readonly wallet: string;
      readonly progress: DecimalString;
    }
  | { readonly code: 'unpriced_leg'; readonly position: string }
  | { readonly code: 'no_usd_rate'; readonly day: string }
  | { readonly code: 'zero_denominator' }
  | { readonly code: 'no_losses' };

export type ExactFigure<Value> =
  | { readonly exactness: 'complete'; readonly value: Value }
  | {
      readonly exactness: 'partial' | 'estimated';
      readonly value: Value;
      readonly reasons: readonly FigureReason[];
    }
  | { readonly exactness: 'unavailable'; readonly reasons: readonly FigureReason[] };

export type Figure = ExactFigure<Money>;

// A percentage already in percent: "2.56" is 2.56 %.
export type PercentFigure = ExactFigure<DecimalString>;

export type RatioFigure = ExactFigure<DecimalString>;

export type PriceQuote = 'sol' | 'usdc' | 'usdt';

export interface Price {
  readonly amount: DecimalString;
  readonly quote: PriceQuote;
}
