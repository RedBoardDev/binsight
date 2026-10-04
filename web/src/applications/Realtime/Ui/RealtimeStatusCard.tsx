import { STREAM_STATE_LABELS } from '@app/applications/Realtime/Ui/streamStateLabels';
import { useRealtimeStatus } from '@app/applications/Realtime/Ui/useRealtimeStatus';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { Card } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

export const RealtimeStatusCard = () => {
  const { i18n, t } = useLingui();
  const { state, lastHeartbeatAt } = useRealtimeStatus();
  const { formatTime } = useDateFormatters();

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t`Live updates`}</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-body">
          <dt className="text-muted">{t`Connection`}</dt>
          <dd>{i18n._(STREAM_STATE_LABELS[state])}</dd>
          <dt className="text-muted">{t`Last heartbeat`}</dt>
          <dd>
            <time dateTime={lastHeartbeatAt ?? undefined}>{formatTime(lastHeartbeatAt)}</time>
          </dd>
        </dl>
      </Card.Content>
    </Card>
  );
};
