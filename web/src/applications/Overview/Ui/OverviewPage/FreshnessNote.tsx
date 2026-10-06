import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';

interface FreshnessNoteProps {
  readonly freshness: Overview['freshness'];
  readonly timeZone: string;
}

// While a wallet catches up, the live figures are dated, beside the Today label.
export const FreshnessNote = ({ freshness, timeZone }: FreshnessNoteProps) => {
  const { t } = useLingui();
  const { formatTime } = useDateFormatters(timeZone);
  if (freshness.state !== 'lagging') return null;
  return (
    <span className="text-small text-faint">{t`Data from ${formatTime(freshness.as_of)}`}</span>
  );
};
