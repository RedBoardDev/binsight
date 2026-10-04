import { useHealth } from '@app/applications/Health/Api/useHealth.api';
import { SettingRow } from '@app/applications/Setting/Ui/SettingsPage/SettingRow';
import { SettingsSection } from '@app/applications/Setting/Ui/SettingsPage/SettingsSection';
import { Link } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

const SOURCE_CODE_URL = 'https://github.com/RedBoardDev/binsight';
const LICENSES_PATH = '/third-party-licenses.txt';

export const AboutSection = () => {
  const { t } = useLingui();
  const health = useHealth();

  return (
    <SettingsSection title={t`About`}>
      <SettingRow label={t`Version`}>
        <span className="num text-body text-muted">{health.data?.version ?? '—'}</span>
      </SettingRow>
      <SettingRow label={t`Open-source licenses`}>
        <Link href={LICENSES_PATH} target="_blank" className="link--body">
          {t`Licenses`}
        </Link>
      </SettingRow>
      <SettingRow label={t`Source code`}>
        <Link href={SOURCE_CODE_URL} target="_blank" rel="noreferrer" className="link--body">
          GitHub
        </Link>
      </SettingRow>
    </SettingsSection>
  );
};
