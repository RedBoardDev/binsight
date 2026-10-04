// How this device shows amounts: in SOL or in dollars, and whether their digits are hidden (for a
// screen share). Device preferences: the URL never carries them, so a shared link opens with the
// reader's own.
export const CURRENCIES = ['sol', 'usd'] as const;

export type Currency = (typeof CURRENCIES)[number];

export interface DisplayPreferences {
  readonly currency: Currency;
  readonly areAmountsHidden: boolean;
}

export const CURRENCY_STORAGE_KEY = 'binsight.currency';
export const HIDDEN_AMOUNTS_STORAGE_KEY = 'binsight.hideAmounts';

const HIDDEN = 'true';

export const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

export const parseDisplayPreferences = (stored: {
  readonly currency: string | null;
  readonly areAmountsHidden: string | null;
}): DisplayPreferences => ({
  currency: isCurrency(stored.currency) ? stored.currency : 'sol',
  areAmountsHidden: stored.areAmountsHidden === HIDDEN,
});

export const serializeAmountsHidden = (areAmountsHidden: boolean): string =>
  areAmountsHidden ? HIDDEN : 'false';

export const otherCurrency = (currency: Currency): Currency => (currency === 'sol' ? 'usd' : 'sol');
