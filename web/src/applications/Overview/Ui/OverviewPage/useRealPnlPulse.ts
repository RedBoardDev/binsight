import { usePulseReadings } from '@app/applications/Overview/Ui/OverviewPage/usePulseReadings';
import { useDisplayPreferences } from '@app/applications/Shared/Preference/Ui/useDisplayPreferences';
import { useScope } from '@app/applications/Shared/Scope/Ui/useScope';
import {
  apiErrorMessage,
  NETWORK_ERROR_MESSAGE,
} from '@app/applications/Shared/Ui/apiErrorMessages';
import { useStatsSeries } from '@app/applications/Stats/Api/useStatsSeries.api';
import { ApiError } from '@app/lib/api/apiError';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

export interface RealPnlPulse {
  readonly series: UseQueryResult<ApiSchema<'StatsSeries'>>;
  readonly errorMessage: string;
  readonly activeIndex: number | null;
  readonly select: (index: number | null) => void;
  readonly summary: string;
  readonly describePoint: (index: number) => string;
}

// The daily real PnL of the scope, and the day being read. A reading belongs to its scope: a new
// wallet, period or currency starts with none.
export const useRealPnlPulse = (): RealPnlPulse => {
  const { i18n } = useLingui();
  const { wallet, period } = useScope();
  const { currency } = useDisplayPreferences();
  const series = useStatsSeries({ wallet, period, currency, series: 'real_pnl', bucket: 'day' });
  const scope = `${wallet}/${period}/${currency}`;
  const [selection, setSelection] = useState<{ scope: string; index: number | null }>({
    scope,
    index: null,
  });
  const { summary, describePoint } = usePulseReadings(series.data);
  const errorMessage =
    series.error instanceof ApiError
      ? i18n._(apiErrorMessage(series.error.code))
      : series.error instanceof TypeError
        ? i18n._(NETWORK_ERROR_MESSAGE)
        : i18n._(apiErrorMessage(null));
  return {
    series,
    errorMessage,
    activeIndex: selection.scope === scope ? selection.index : null,
    select: (index) => setSelection({ scope, index }),
    summary,
    describePoint,
  };
};
