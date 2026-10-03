import { useHealth } from '@app/applications/Health/Api/useHealth.api';
import { Link } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

const SOURCE_CODE_URL = 'https://github.com/RedBoardDev/binsight';
const LICENSES_PATH = '/third-party-licenses.txt';

export const AboutFooter = () => {
  const { t } = useLingui();
  const health = useHealth();

  return (
    <footer className="mt-auto flex flex-wrap items-center gap-x-2 px-3 py-2 text-muted text-xs">
      <span>binsight{health.data === undefined ? '' : ` v${health.data.version}`}</span>
      <span aria-hidden>·</span>
      <Link href={LICENSES_PATH} target="_blank" className="text-xs">
        {t`Licenses`}
      </Link>
      <span aria-hidden>·</span>
      <Link href={SOURCE_CODE_URL} target="_blank" rel="noreferrer" className="text-xs">
        GitHub
      </Link>
    </footer>
  );
};
