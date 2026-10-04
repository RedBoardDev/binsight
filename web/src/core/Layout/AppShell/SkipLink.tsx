import { useLingui } from '@lingui/react/macro';

export const MAIN_CONTENT_ID = 'content';

export const SkipLink = () => {
  const { t } = useLingui();

  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only rounded-lg bg-overlay px-4 py-2 font-medium text-body shadow-overlay focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
    >
      {t`Skip to content`}
    </a>
  );
};
