import { isThemePreference } from '@app/core/theme/themePreference';
import { useThemePreference } from '@app/core/theme/useThemePreference';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Monitor, Moon, Sun } from 'lucide-react';

const THEME_OPTIONS = [
  { preference: 'light', label: msg`Light theme`, Icon: Sun },
  { preference: 'dark', label: msg`Dark theme`, Icon: Moon },
  { preference: 'system', label: msg`System theme`, Icon: Monitor },
] as const;

export const ThemeSwitcher = () => {
  const { i18n, t } = useLingui();
  const { preference, setPreference } = useThemePreference();

  return (
    <ToggleButtonGroup
      aria-label={t`Theme`}
      selectionMode="single"
      disallowEmptySelection
      size="lg"
      selectedKeys={[preference]}
      onSelectionChange={(keys) => {
        const [selected] = keys;
        if (isThemePreference(selected)) {
          setPreference(selected);
        }
      }}
    >
      {THEME_OPTIONS.map(({ preference: option, label, Icon }, index) => (
        <ToggleButton key={option} id={option} isIconOnly aria-label={i18n._(label)}>
          {index > 0 && <ToggleButtonGroup.Separator />}
          <Icon aria-hidden />
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
};
