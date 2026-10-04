import { HealthCard } from '@app/applications/Health/Ui/HealthCard';
import { RealtimeStatusCard } from '@app/applications/Realtime/Ui/RealtimeStatusCard';
import { PageHeader } from '@app/applications/Shared/Layout/Ui/PageHeader';
import { useLingui } from '@lingui/react/macro';

export const HealthPage = () => {
  const { t } = useLingui();

  return (
    <>
      <PageHeader title={t`Health`} />
      <div className="grid gap-4 md:grid-cols-2">
        <HealthCard />
        <RealtimeStatusCard />
      </div>
    </>
  );
};
