import type { Health } from '@app/applications/Health/Api/getHealth';
import {
  COMPONENT_STATUS_LABELS,
  ENGINE_STATUS_LABELS,
  HEALTH_STATUS_LABELS,
} from '@app/applications/Health/Ui/HealthCard/healthLabels';
import { Chip } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

const STATUS_COLORS = { ok: 'success', degraded: 'warning', unavailable: 'danger' } as const;

interface HealthReportProps {
  health: Health;
}

export const HealthReport = ({ health }: HealthReportProps) => {
  const { i18n, t } = useLingui();

  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-body">
      <dt className="text-muted">{t`Status`}</dt>
      <dd>
        <Chip color={STATUS_COLORS[health.status]} variant="soft">
          {i18n._(HEALTH_STATUS_LABELS[health.status])}
        </Chip>
      </dd>
      <dt className="text-muted">{t`Version`}</dt>
      <dd className="font-mono">{health.version}</dd>
      <dt className="text-muted">{t`Database`}</dt>
      <dd>{i18n._(COMPONENT_STATUS_LABELS[health.database])}</dd>
      <dt className="text-muted">{t`Engine`}</dt>
      <dd>{i18n._(ENGINE_STATUS_LABELS[health.engine])}</dd>
    </dl>
  );
};
