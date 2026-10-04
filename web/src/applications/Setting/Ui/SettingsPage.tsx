import { SignOutButton } from '@app/applications/Auth/Ui/SignOutButton';
import { PageHeader } from '@app/applications/Shared/Layout/Ui/PageHeader';
import { ReduceMotionSwitch } from '@app/applications/Shared/Motion/Ui/ReduceMotionSwitch';
import { LocaleSwitcher } from '@app/core/i18n/LocaleSwitcher';
import { ThemeSwitcher } from '@app/core/theme/ThemeSwitcher';
import { useLingui } from '@lingui/react/macro';
import { AboutSection } from './SettingsPage/AboutSection';
import { SettingRow } from './SettingsPage/SettingRow';
import { SettingsSection } from './SettingsPage/SettingsSection';

export const SettingsPage = () => {
  const { t } = useLingui();

  return (
    <>
      <PageHeader title={t`Settings`} />
      <div className="flex max-w-2xl flex-col gap-14">
        <SettingsSection title={t`Display`}>
          <SettingRow label={t`Theme`}>
            <ThemeSwitcher />
          </SettingRow>
          <SettingRow label={t`Language`}>
            <LocaleSwitcher />
          </SettingRow>
          <div className="py-3">
            <ReduceMotionSwitch />
          </div>
        </SettingsSection>
        <SettingsSection title={t`Session`}>
          <SettingRow label={t`Sign out of this device`}>
            {/* A text button keeps its padding: pulled out by it, its label lines up on the right
                edge with the other values. */}
            <div className="-me-4">
              <SignOutButton />
            </div>
          </SettingRow>
        </SettingsSection>
        <AboutSection />
      </div>
    </>
  );
};
