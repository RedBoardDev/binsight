import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { useLingui } from '@lingui/react/macro';

interface OverviewSkeletonProps {
  readonly layout: 'stocks' | 'compact';
}

export const OverviewSkeleton = ({ layout }: OverviewSkeletonProps) => {
  const { t } = useLingui();
  const isStocks = layout === 'stocks';
  return (
    <div
      role="status"
      aria-label={t`Loading overview`}
      className={`flex flex-col gap-6 ${isStocks ? 'w-80' : ''}`}
    >
      <div className="flex flex-col gap-3">
        <SkeletonBlock className="h-4 w-28" />
        <div className="flex items-baseline gap-3">
          <SkeletonBlock className={isStocks ? 'h-13 w-48' : 'h-9 w-40'} />
          <SkeletonBlock className="h-4 w-14" />
        </div>
        <SkeletonBlock className={isStocks ? 'h-4 w-56' : 'h-11 w-56'} />
      </div>
      <div
        className={
          isStocks ? 'flex flex-col' : 'grid grid-cols-3 gap-4 border-t border-border-subtle pt-4'
        }
      >
        {(isStocks ? [0, 1, 2, 3] : [0, 1, 2]).map((row) => (
          <div
            key={row}
            className={
              isStocks
                ? 'flex h-10 items-center justify-between gap-4 border-b border-border-subtle'
                : 'flex flex-col gap-2'
            }
          >
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
};
