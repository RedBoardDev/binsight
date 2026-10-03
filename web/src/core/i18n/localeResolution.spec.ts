import { resolveInitialLocale } from '@app/core/i18n/localeResolution';
import { describe, expect, it } from 'vitest';

describe('resolveInitialLocale', () => {
  it('prefers the stored locale over the browser languages', () => {
    expect(resolveInitialLocale({ stored: 'de', browserLanguages: ['fr-FR', 'en-US'] })).toBe('de');
  });

  it('takes the first browser language the app supports', () => {
    expect(resolveInitialLocale({ stored: null, browserLanguages: ['es-ES', 'fr-CA', 'de'] })).toBe(
      'fr',
    );
  });

  it('ignores a stored value the app does not support', () => {
    expect(resolveInitialLocale({ stored: 'it', browserLanguages: ['DE-de'] })).toBe('de');
  });

  it('falls back to English when nothing matches', () => {
    expect(resolveInitialLocale({ stored: null, browserLanguages: ['ja-JP'] })).toBe('en');
    expect(resolveInitialLocale({ stored: null, browserLanguages: [] })).toBe('en');
  });
});
