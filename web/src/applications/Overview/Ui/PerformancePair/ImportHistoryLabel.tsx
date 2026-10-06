import { formattedText } from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';

interface ImportHistoryLabelProps {
  readonly importing: ApiSchema<'OverviewV2'>['sync']['importing'];
}

export const ImportHistoryLabel = ({ importing }: ImportHistoryLabelProps) => {
  const { t } = useLingui();
  const format = useFigureFormatter();
  if (importing.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {importing.map(({ wallet, progress }) => (
        <li key={wallet.address}>
          {progress === null
            ? t`${wallet.label} is importing history`
            : t`${wallet.label} history ${formattedText(format.percent(progress, 'hero', 'negative-only'))}`}
        </li>
      ))}
    </ul>
  );
};
