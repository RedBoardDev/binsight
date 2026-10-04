import type {
  Exactness,
  FigureReason,
  MoneyUnit,
} from '@app/applications/Shared/Figure/Domain/figure';
import { formatPercent } from '@app/applications/Shared/Figure/Domain/formatPercent';
import {
  type FormattedNumber,
  formattedText,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

// What a screen reader says for a figure: "minus 0.949 SOL, lower bound". The glyphs, the true
// minus and the Solana mark are hidden from it; this text says the same in words.

const NOT_AVAILABLE = msg`not available`;

const EXACTNESS_WORDS: Record<Exactness, MessageDescriptor | null> = {
  complete: null,
  partial: msg`lower bound`,
  estimated: msg`estimated`,
  unavailable: NOT_AVAILABLE,
};

const UNIT_WORDS: Record<MoneyUnit, string> = {
  sol: 'SOL',
  usd: 'USD',
  usdc: 'USDC',
  usdt: 'USDT',
};

const SIGN_WORDS = { '+': msg`plus`, '−': msg`minus` } as const;

export const EXACTNESS_QUESTIONS: Record<Exclude<Exactness, 'complete'>, MessageDescriptor> = {
  partial: msg`Why a lower bound?`,
  estimated: msg`Why an estimate?`,
  unavailable: msg`Why not available?`,
};

export const EXACTNESS_TITLES: Record<Exclude<Exactness, 'complete'>, MessageDescriptor> = {
  partial: msg`Lower bound`,
  estimated: msg`Estimated`,
  unavailable: msg`Not available`,
};

interface SpokenFigure {
  readonly formatted: FormattedNumber | null;
  readonly unit: MoneyUnit | null;
  readonly exactness: Exactness;
  readonly isHidden: boolean;
}

export const speakFigure = (i18n: I18n, figure: SpokenFigure): string => {
  const exactness = EXACTNESS_WORDS[figure.exactness];
  if (figure.formatted === null) {
    return i18n._(NOT_AVAILABLE);
  }
  const { sign } = figure.formatted;
  // A visible dollar amount carries its "$"; a hidden one says its unit in words.
  const isUnitInText = figure.unit === 'usd' && !figure.isHidden;
  const unitWord = figure.unit === null || isUnitInText ? '' : UNIT_WORDS[figure.unit];
  const words = [
    sign === '' ? '' : i18n._(SIGN_WORDS[sign]),
    figure.isHidden ? i18n._(msg`amount hidden`) : formattedText(figure.formatted),
    unitWord,
  ].filter((word) => word !== '');
  const spoken = words.join(' ');
  return exactness === null ? spoken : `${spoken}, ${i18n._(exactness)}`;
};

export const describeReason = (i18n: I18n, reason: FigureReason): string => {
  switch (reason.code) {
    case 'unpriced_token': {
      const { symbol } = reason.token;
      return i18n._(msg`${symbol} has no price yet: it counts as zero.`);
    }
    case 'reconstructed_history':
      return i18n._(msg`Reconstructed for the time before the wallet was added.`);
    case 'history_incomplete': {
      const progress = formattedText(
        formatPercent(reason.progress, {
          languageTag: i18n.locale,
          placement: 'hero',
          signing: 'negative-only',
        }),
      );
      return i18n._(msg`History still importing: ${progress} done.`);
    }
    case 'unpriced_leg':
      return i18n._(msg`A movement of the position has no price.`);
    case 'no_usd_rate': {
      const { day } = reason;
      return i18n._(msg`No SOL to dollar rate for ${day}.`);
    }
    case 'zero_denominator':
      return i18n._(msg`Nothing to compare with yet.`);
    case 'no_losses':
      return i18n._(msg`No losing position yet.`);
  }
};
