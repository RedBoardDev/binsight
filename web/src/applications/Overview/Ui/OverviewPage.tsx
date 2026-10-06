import { useOverview } from '@app/applications/Overview/Api/useOverview.api';
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
import { useEffect } from 'react';
import { OverviewDesktop } from './OverviewPage/OverviewDesktop';
import { OverviewDesktopSkeleton } from './OverviewPage/OverviewDesktopSkeleton';
import { OverviewMobile } from './OverviewPage/OverviewMobile';
import { OverviewMobileSkeleton } from './OverviewPage/OverviewMobileSkeleton';
import { buildTodayHistoryHref } from './OverviewPage/todayHistoryHref';

const APP_NAME = 'binsight';

// The page opens on its figures: its title is for screen readers and the browser tab only. A
// navigation still moves the focus to it (AppShell).
export const OverviewPage = () => {
  const { t, i18n } = useLingui();
  const { wallet, period } = useScope();
  const { currency } = useDisplayPreferences();
  const isDesktop = useIsDesktop();
  const overview = useOverview({ wallet, period, currency });
  const { formatTime } = useDateFormatters(overview.data?.today.window.timezone);
  const title = t`Overview`;
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
  const message =
    overview.error instanceof ApiError
      ? i18n._(apiErrorMessage(overview.error.code))
      : overview.error instanceof TypeError
        ? i18n._(NETWORK_ERROR_MESSAGE)
        : i18n._(apiErrorMessage(null));

  return (
    <>
      <h1 tabIndex={-1} className="sr-only">
        {title}
      </h1>
      {overview.isPending && (isDesktop ? <OverviewDesktopSkeleton /> : <OverviewMobileSkeleton />)}
      {overview.isError && (
        <div className="mb-6">
          <SectionError message={message} onRetry={() => void overview.refetch()} />
          {overview.isRefetchError && overview.data !== undefined && (
            <p className="text-muted text-small">{t`Data from ${formatTime(overview.data.freshness.as_of)}`}</p>
          )}
        </div>
      )}
      {overview.data !== undefined && (
        <div data-freshness={overview.isRefetchError ? 'error' : overview.data.freshness.state}>
          {isDesktop ? (
            <OverviewDesktop
              overview={overview.data}
              period={period}
              historyHref={buildTodayHistoryHref({ window: overview.data.today.window, wallet })}
            />
          ) : (
            <OverviewMobile overview={overview.data} />
          )}
        </div>
      )}
    </>
  );
};
