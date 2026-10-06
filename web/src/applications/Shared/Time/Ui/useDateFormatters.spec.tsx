import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { AppProviders } from '@app/core/AppProviders';
import { messages as frenchMessages } from '@app/locales/fr/messages.po';
import { i18n } from '@lingui/core';
import { createTestQueryClient } from '@test/createTestQueryClient';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppProviders queryClient={createTestQueryClient()}>{children}</AppProviders>
);

describe('useDateFormatters', () => {
  it('formats a timestamp in the active language', () => {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
    const { result } = renderHook(() => useDateFormatters(), { wrapper });
    const timestamp = '2026-10-03T21:00:15Z';
    const expectedTime = new Intl.DateTimeFormat('en-US', { timeStyle: 'medium' }).format(
      new Date(timestamp),
    );

    expect(result.current.formatTime(timestamp)).toBe(expectedTime);

    act(() => i18n.loadAndActivate({ locale: 'fr', messages: frenchMessages }));

    expect(result.current.formatTime(timestamp)).toBe(
      new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' }).format(new Date(timestamp)),
    );
  });

  it('shows a dash for a missing or invalid timestamp', () => {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
    const { result } = renderHook(() => useDateFormatters(), { wrapper });

    expect(result.current.formatDateTime(null)).toBe('—');
    expect(result.current.formatDateTime('not a date')).toBe('—');
    expect(result.current.formatShortDate(null)).toBe('—');
    expect(result.current.formatShortDate('not a date')).toBe('—');
  });

  it('uses the supplied server time zone across midnight and daylight saving changes', () => {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
    const { result, rerender } = renderHook(
      ({ timeZone }: { timeZone: string | undefined }) => useDateFormatters(timeZone),
      { wrapper, initialProps: { timeZone: 'Europe/Berlin' as string | undefined } },
    );
    expect(result.current.formatShortDate('2026-10-05T22:30:00Z')).toBe('Oct 6');
    expect(result.current.formatTime('2026-03-29T00:30:00Z')).toBe('1:30:00 AM');
    expect(result.current.formatTime('2026-03-29T01:30:00Z')).toBe('3:30:00 AM');
    rerender({ timeZone: 'UTC' });
    expect(result.current.formatShortDate('2026-10-05T22:30:00Z')).toBe('Oct 5');
    rerender({ timeZone: undefined });
    expect(result.current.formatTime('2026-10-05T22:30:00Z')).toBe(
      new Intl.DateTimeFormat('en-US', { timeStyle: 'medium' }).format(
        new Date('2026-10-05T22:30:00Z'),
      ),
    );
  });

  it('formats compact chart dates in the same language and time zone as other dates', () => {
    i18n.loadAndActivate({ locale: 'fr', messages: frenchMessages });
    const { result } = renderHook(() => useDateFormatters(), { wrapper });
    const timestamp = '2026-10-03T21:00:15Z';
    expect(result.current.formatShortDate(timestamp)).toBe(
      new Intl.DateTimeFormat('fr-FR', { month: 'short', day: 'numeric' }).format(
        new Date(timestamp),
      ),
    );
  });
});
