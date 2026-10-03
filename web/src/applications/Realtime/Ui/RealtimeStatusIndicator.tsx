import {
  STREAM_STATE_COLORS,
  STREAM_STATE_LABELS,
} from '@app/applications/Realtime/Ui/streamStateLabels';
import { useRealtimeStatus } from '@app/applications/Realtime/Ui/useRealtimeStatus';
import { Chip } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

export const RealtimeStatusIndicator = () => {
  const { i18n, t } = useLingui();
  const { state } = useRealtimeStatus();
  const label = i18n._(STREAM_STATE_LABELS[state]);

  return (
    <Chip
      role="status"
      aria-label={t`Live updates: ${label}`}
      color={STREAM_STATE_COLORS[state]}
      variant="soft"
      size="sm"
    >
      {label}
    </Chip>
  );
};
