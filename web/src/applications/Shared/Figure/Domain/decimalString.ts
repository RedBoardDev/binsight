// An exact decimal number as the API sends it: canonical (no exponent, no trailing zero, no "+",
// no "-0"), of any length. The app never turns one into a JavaScript number: it is formatted by
// Intl.NumberFormat, which rounds a string exactly. Everything below reads the string itself.

declare const decimalStringBrand: unique symbol;

export type DecimalString = `${number}` & { readonly [decimalStringBrand]: true };

const CANONICAL_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

export const isDecimalString = (value: string): value is DecimalString =>
  CANONICAL_DECIMAL.test(value) && value !== '-0';

export const parseDecimalString = (value: string): DecimalString | null =>
  isDecimalString(value) ? value : null;

const unsignedPart = (value: DecimalString): string =>
  value.startsWith('-') ? value.slice(1) : value;

export const integerDigitCount = (value: DecimalString): number =>
  unsignedPart(value).split('.')[0]?.length ?? 0;

export const isFractionOfOne = (value: DecimalString): boolean =>
  unsignedPart(value).startsWith('0.');
