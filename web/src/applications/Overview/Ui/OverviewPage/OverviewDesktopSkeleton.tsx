import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { useLingui } from '@lingui/react/macro';

const KEY_FIGURE_ROWS = [0, 1, 2, 3] as const;

// The desktop header at its real size while the overview loads: no jump when it arrives.
export const OverviewDesktopSkeleton = () => {
  const { t } = useLingui();
  return (
    <div
      role="status"
      aria-label={t`Loading overview`}
      className="grid grid-cols-[20rem_minmax(0,1fr)] gap-x-16"
    >
      <div className="flex flex-col justify-between gap-6">
        <div className="flex flex-col gap-3">
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="h-13 w-52" />
          <SkeletonBlock className="h-4 w-44" />
        </div>
        <div>
          {KEY_FIGURE_ROWS.map((row) => (
            <div key={row} className="flex h-10 items-center justify-between gap-4">
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <SkeletonBlock className="h-68 w-full" />
    </div>
  );
};
