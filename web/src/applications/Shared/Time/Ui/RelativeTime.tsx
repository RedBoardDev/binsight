import { relativeTime } from '@app/applications/Shared/Time/Domain/relativeTime';
import { relativeTimeFormat } from '@app/applications/Shared/Time/Domain/timeFormat';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useNow } from '@app/applications/Shared/Time/Ui/useNow';
import { useLanguageTag } from '@app/core/i18n/useLanguageTag';
import { useLingui } from '@lingui/react/macro';

const MS_PER_SECOND = 1_000;

interface RelativeTimeProps {
  timestamp: string;
}

export const RelativeTime = ({ timestamp }: RelativeTimeProps) => {
  const { t } = useLingui();
  const languageTag = useLanguageTag();
  const now = useNow();
  const { formatDateTime } = useDateFormatters();
  const at = new Date(timestamp).getTime();
  // A malformed timestamp would make Intl throw and take the page down with it.
  if (Number.isNaN(at)) {
    return <span>—</span>;
  }
  const elapsed = relativeTime((now - at) / MS_PER_SECOND);
  const text =
    elapsed.kind === 'just-now'
      ? t`just now`
      : relativeTimeFormat(languageTag, { style: 'short' }).format(-elapsed.value, elapsed.unit);

  return (
    <time dateTime={timestamp} title={formatDateTime(timestamp)}>
      {text}
    </time>
  );
};
