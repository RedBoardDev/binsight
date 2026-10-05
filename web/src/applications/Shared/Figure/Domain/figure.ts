import type { components } from '@app/lib/api/generated/openapi';

type ApiSchema<Name extends keyof components['schemas']> = components['schemas'][Name];

// Wire shapes come from the generated contract. Decimal strings are validated at formatting
// boundaries; the local brand never pretends that a generated string was already checked.
export type Money = ApiSchema<'Money'>;
export type MoneyUnit = Money['unit'];
export type Figure = ApiSchema<'Figure'>;
export type Exactness = Figure['exactness'];
export type FigureReason = ApiSchema<'Reason'>;
export type PercentFigure = ApiSchema<'PercentFigure'>;
// The visual ratio has the same shape until its endpoint supplies a distinct schema.
export type RatioFigure = PercentFigure;
export type Price = ApiSchema<'Price'>;
export type PriceQuote = Price['quote'];
export type TokenRef = ApiSchema<'TokenRef'>;
