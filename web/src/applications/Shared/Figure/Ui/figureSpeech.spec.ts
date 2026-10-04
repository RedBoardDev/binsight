import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { describeReason } from '@app/applications/Shared/Figure/Ui/figureSpeech';
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
  afterEach(() => i18n.loadAndActivate({ locale: 'en', messages: englishMessages }));

  it('writes the import progress as a percentage of the language', () => {
    i18n.loadAndActivate({ locale: 'fr', messages: frenchMessages });

    const sentence = describeReason(i18n, importing('32.5'));

    // French puts no-break spaces around the colon and before the percent sign.
    expect(sentence.replace(/[\u00a0\u202f]/g, ' ')).toBe(
      'Historique en cours d’import : 32,5 % fait.',
    );
  });
});
