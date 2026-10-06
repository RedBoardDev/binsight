import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { useLingui } from '@lingui/react/macro';

const KEY_FIGURES = [0, 1, 2] as const;

// The phone's header at its real size while the overview loads.
export const OverviewMobileSkeleton = () => {
  const { t } = useLingui();
  return (
    <div role="status" aria-label={t`Loading overview`} className="flex flex-col gap-7">
      <div>
        <SkeletonBlock className="h-4 w-16" />
        <SkeletonBlock className="mt-3 h-9 w-48" />
        <div className="mt-5 flex gap-3 border-border border-t pt-4">
          {KEY_FIGURES.map((figure) => (
            <div key={figure} className="flex flex-1 flex-col gap-2">
              <SkeletonBlock className="h-3 w-16" />
              <SkeletonBlock className="h-5 w-20" />
            </div>
          ))}
        </div>
      </div>
      <SkeletonBlock className="h-44 w-full" />
    </div>
  );
};
