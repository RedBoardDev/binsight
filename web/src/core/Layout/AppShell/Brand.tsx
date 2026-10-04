import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';

const BrandMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden className="size-5.5 text-accent">
    <rect x="2" y="12" width="4.4" height="9" rx="1.4" fill="currentColor" fillOpacity="0.55" />
    <rect x="9.8" y="3" width="4.4" height="18" rx="1.4" fill="currentColor" />
    <rect x="17.6" y="8" width="4.4" height="13" rx="1.4" fill="currentColor" fillOpacity="0.8" />
  </svg>
);

export const Brand = () => {
  const { t } = useLingui();

  return (
    <Link
      to="/"
      aria-label={t`binsight, overview`}
      className="inline-flex h-11 shrink-0 items-center gap-2.5 rounded-lg"
    >
      <BrandMark />
      <span aria-hidden className="text-section">
        binsight
      </span>
    </Link>
  );
};
