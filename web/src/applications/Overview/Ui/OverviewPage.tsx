import { PageHeader } from '@app/applications/Shared/Layout/Ui/PageHeader';
import { useLingui } from '@lingui/react/macro';

export const OverviewPage = () => {
  const { t } = useLingui();

  return <PageHeader title={t`Overview`} />;
};
