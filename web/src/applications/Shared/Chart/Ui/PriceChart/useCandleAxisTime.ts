import { dateTimeFormat } from '@app/applications/Shared/Time/Domain/timeFormat';
import { useInstanceTimeZone } from '@app/applications/Shared/Time/Ui/useInstanceTimeZone';
import { useLanguageTag } from '@app/core/i18n/useLanguageTag';
import { useCallback } from 'react';

export const useCandleAxisTime = (): ((timestamp: string, scale: 'date' | 'time') => string) => {
  const languageTag = useLanguageTag();
  const timeZone = useInstanceTimeZone();
  return useCallback(
    (timestamp, scale) =>
      dateTimeFormat(languageTag, {
        timeZone,
        ...(scale === 'date'
          ? { month: 'short', day: 'numeric' }
          : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      }).format(new Date(timestamp)),
    [languageTag, timeZone],
  );
};
