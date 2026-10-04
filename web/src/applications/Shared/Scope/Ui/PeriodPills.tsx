import { TextPills } from '@app/applications/Shared/Control/Ui/TextPills';
import { PERIOD_LABELS, PERIODS } from '@app/applications/Shared/Scope/Domain/period';
import { useScope } from '@app/applications/Shared/Scope/Ui/useScope';
import { useLingui } from '@lingui/react/macro';

export const PeriodPills = () => {
  const { i18n, t } = useLingui();
  const { period, setPeriod } = useScope();
  const options = PERIODS.map((id) => ({ id, label: i18n._(PERIOD_LABELS[id]) }));

  return <TextPills label={t`Period`} options={options} selected={period} onChange={setPeriod} />;
};
