import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { describeReason } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { messages as germanMessages } from '@app/locales/de/messages.po';
import { messages as englishMessages } from '@app/locales/en/messages.po';
import { messages as frenchMessages } from '@app/locales/fr/messages.po';
import { i18n } from '@lingui/core';
import { afterEach, describe, expect, it } from 'vitest';

const importing = (progress: string) => {
  const parsed = parseDecimalString(progress);
  if (parsed === null) {
    throw new Error(`${progress} is not a decimal string`);
  }
  return { code: 'history_incomplete', wallet: 'wallet-address', progress: parsed } as const;
};

describe('describeReason', () => {
  it('distinguishes an old mark from a missing historical valuation in each language', () => {
    const cases = [
      [
        'en',
        englishMessages,
        'Open PnL uses a mark 30 seconds before this point.',
        'No valuation is available for the positions open at this point.',
      ],
      [
        'fr',
        frenchMessages,
        'Le PnL des positions ouvertes utilise une mesure antérieure de 30 secondes à ce point.',
        'Aucune valorisation n’est disponible pour les positions ouvertes à ce point.',
      ],
      [
        'de',
        germanMessages,
        'Der PnL offener Positionen verwendet eine Bewertung 30 Sekunden vor diesem Zeitpunkt.',
        'Für die zu diesem Zeitpunkt offenen Positionen ist keine Bewertung verfügbar.',
      ],
    ] as const;
    for (const [locale, messages, stale, missing] of cases) {
      i18n.loadAndActivate({ locale, messages });
      expect(describeReason(i18n, { code: 'stale_mark', age_seconds: 30 })).toBe(stale);
      expect(describeReason(i18n, { code: 'missing_open_pnl_mark', wallet: 'sample-wallet' })).toBe(
        missing,
      );
    }
  });

  it('explains a provisional conversion with its UTC day in each language', () => {
    const cases = [
      ['en', englishMessages, 'Converted with the provisional SOL to dollar rate for 2026-10-05.'],
      [
        'fr',
        frenchMessages,
        'Conversion avec le taux provisoire du SOL en dollars pour le 2026-10-05.',
      ],
      ['de', germanMessages, 'Mit dem vorläufigen SOL-Dollar-Kurs für den 2026-10-05 umgerechnet.'],
    ] as const;
    for (const [locale, messages, expected] of cases) {
      i18n.loadAndActivate({ locale, messages });
      expect(describeReason(i18n, { code: 'provisional_rate', day: '2026-10-05' })).toBe(expected);
    }
  });
  afterEach(() => i18n.loadAndActivate({ locale: 'en', messages: englishMessages }));

  it('writes the import progress as a percentage of the language', () => {
    i18n.loadAndActivate({ locale: 'fr', messages: frenchMessages });

    const sentence = describeReason(i18n, importing('32.5'));

    // French puts no-break spaces around the colon and before the percent sign.
    expect(sentence.replace(/[\u00a0\u202f]/g, ' ')).toBe(
      'Historique en cours d’import : 32,5 % fait.',
    );
  });

  it('describes an import without inventing a percentage when its total is unknown', () => {
    const cases = [
      ['en', englishMessages, 'History still importing.'],
      ['fr', frenchMessages, 'Historique en cours d’import.'],
      ['de', germanMessages, 'Verlauf wird noch importiert.'],
    ] as const;
    for (const [locale, messages, expected] of cases) {
      i18n.loadAndActivate({ locale, messages });
      expect(
        describeReason(i18n, {
          code: 'history_incomplete',
          wallet: 'wallet-address',
          progress: null,
        }),
      ).toBe(expected);
    }
    i18n.loadAndActivate({ locale: 'en', messages: englishMessages });
    expect(describeReason(i18n, importing('0'))).toBe('History still importing: 0.0% done.');
  });
});
