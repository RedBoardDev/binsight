import { useOverview } from '@app/applications/Overview/Api/useOverview.api';
import { PageHeader } from '@app/applications/Shared/Layout/Ui/PageHeader';
import { SectionError } from '@app/applications/Shared/Layout/Ui/SectionError';
import { useIsDesktop } from '@app/applications/Shared/Layout/Ui/useIsDesktop';
import { useDisplayPreferences } from '@app/applications/Shared/Preference/Ui/useDisplayPreferences';
import { useScope } from '@app/applications/Shared/Scope/Ui/useScope';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import {
  apiErrorMessage,
  NETWORK_ERROR_MESSAGE,
} from '@app/applications/Shared/Ui/apiErrorMessages';
import { ApiError } from '@app/lib/api/apiError';
import { useLingui } from '@lingui/react/macro';
import { OverviewDesktop } from './OverviewPage/OverviewDesktop';
import { OverviewMobile } from './OverviewPage/OverviewMobile';
import { OverviewSkeleton } from './OverviewPage/OverviewSkeleton';
import { buildTodayHistoryHref } from './OverviewPage/todayHistoryHref';

export const OverviewPage = () => {
  const { t, i18n } = useLingui();
  const { wallet, period } = useScope();
  const { currency } = useDisplayPreferences();
  const isDesktop = useIsDesktop();
  const overview = useOverview({ wallet, period, currency });
  const { formatTime } = useDateFormatters(overview.data?.today.window.timezone);
  const message =
    overview.error instanceof ApiError
      ? i18n._(apiErrorMessage(overview.error.code))
      : overview.error instanceof TypeError
        ? i18n._(NETWORK_ERROR_MESSAGE)
        : i18n._(apiErrorMessage(null));
  const PageFigures = isDesktop ? OverviewDesktop : OverviewMobile;

  return (
    <>
      <PageHeader title={t`Overview`} />
      {overview.isPending ? (
        <OverviewSkeleton layout={isDesktop ? 'stocks' : 'compact'} />
      ) : (
        <div className="flex flex-col gap-6">
          {overview.isError && (
            <div>
              <SectionError message={message} onRetry={() => void overview.refetch()} />
              {overview.isRefetchError && overview.data !== undefined && (
                <p className="text-small text-muted">{t`Data from ${formatTime(overview.data.freshness.as_of)}`}</p>
              )}
            </div>
          )}
          {overview.data !== undefined && (
            <div data-freshness={overview.isRefetchError ? 'error' : overview.data.freshness.state}>
              <PageFigures
                overview={overview.data}
                period={period}
                historyHref={buildTodayHistoryHref({ window: overview.data.today.window, wallet })}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
};
