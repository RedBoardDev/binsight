import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { dataTimestamp, isCatchingUp } from '@app/applications/Overview/Domain/dataFreshness';
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
  if (!isCatchingUp(freshness)) return null;
  return (
    <span className="text-faint text-small">{t`Data from ${formatTime(dataTimestamp(freshness))}`}</span>
  );
};
