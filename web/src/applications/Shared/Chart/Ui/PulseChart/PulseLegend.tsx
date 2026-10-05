import { useLingui } from '@lingui/react/macro';

export const PulseLegend = () => {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-5 text-small text-muted">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="h-3 w-1 rounded-sm bg-muted" />
        {t`Daily`}
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="h-px w-4 bg-accent" />
        {t`Cumulative`}
      </span>
    </div>
  );
};
