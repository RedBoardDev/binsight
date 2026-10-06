import type { ChartStroke } from '@app/applications/Shared/Chart/Domain/estimatedSegments';
import { useLingui } from '@lingui/react/macro';

const CURVE_SWATCH_CLASSES: Record<ChartStroke['style'], string> = {
  solid: 'border-solid',
  dashed: 'border-dashed',
};

interface PulseLegendProps {
  // The style the curve ends in: an estimated curve is dashed, and so is its swatch.
  readonly curve: ChartStroke['style'];
}

export const PulseLegend = ({ curve }: PulseLegendProps) => {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-3 text-faint text-small">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-flex gap-0.5">
          <span className="h-2.5 w-0.75 rounded-xs bg-gain/60" />
          <span className="h-2.5 w-0.75 rounded-xs bg-loss/60" />
        </span>
        {t`Daily`}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className={`w-3 border-accent border-t-2 ${CURVE_SWATCH_CLASSES[curve]}`}
        />
        {t`Cumulative`}
      </span>
    </div>
  );
};
