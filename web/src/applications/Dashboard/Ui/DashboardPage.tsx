import { useLingui } from '@lingui/react/macro';

export const DashboardPage = () => {
  const { t } = useLingui();

  return <h1 className="font-semibold text-2xl">{t`Dashboard`}</h1>;
};
