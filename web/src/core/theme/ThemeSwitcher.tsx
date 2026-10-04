import { isThemePreference } from '@app/core/theme/themePreference';
import { useThemePreference } from '@app/core/theme/useThemePreference';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Monitor, Moon, Sun } from 'lucide-react';
import { SelectionIndicator } from 'react-aria-components';

const THEME_OPTIONS = [
  { preference: 'system', label: msg`System theme`, Icon: Monitor },
  { preference: 'light', label: msg`Light theme`, Icon: Sun },
  { preference: 'dark', label: msg`Dark theme`, Icon: Moon },
] as const;

export const ThemeSwitcher = () => {
  const { i18n, t } = useLingui();
  const { preference, setPreference } = useThemePreference();

  return (
    <ToggleButtonGroup
      aria-label={t`Theme`}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[preference]}
      onSelectionChange={(keys) => {
        const [selected] = keys;
        if (isThemePreference(selected)) {
          setPreference(selected);
        }
      }}
    >
      {THEME_OPTIONS.map(({ preference: option, label, Icon }) => (
        <ToggleButton key={option} id={option} isIconOnly aria-label={i18n._(label)}>
          <SelectionIndicator className="segment-indicator" />
          <Icon aria-hidden strokeWidth={1.75} className="size-4" />
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
};
