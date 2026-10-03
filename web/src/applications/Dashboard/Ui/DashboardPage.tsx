import { HealthCard } from '@app/applications/Health/Ui/HealthCard';
import { RealtimeStatusCard } from '@app/applications/Realtime/Ui/RealtimeStatusCard';
import { useLingui } from '@lingui/react/macro';

export const DashboardPage = () => {
  const { t } = useLingui();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl">{t`Dashboard`}</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <HealthCard />
        <RealtimeStatusCard />
      </div>
    </div>
  );
};
