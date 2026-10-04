import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { useDisplayPreferences } from '@app/applications/Shared/Preference/Ui/useDisplayPreferences';
import { ToggleButton } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { Eye, EyeOff } from 'lucide-react';

export const HideAmountsToggle = () => {
  const { t } = useLingui();
  const { areAmountsHidden } = useDisplayPreferences();
  const Icon = areAmountsHidden ? EyeOff : Eye;

  return (
    <ToggleButton
      isIconOnly
      variant="ghost"
      aria-label={t`Hide amounts`}
      isSelected={areAmountsHidden}
      onChange={displayPreferenceStore.setAmountsHidden}
      className="toggle-button--chrome"
    >
      <Icon aria-hidden strokeWidth={1.75} className="size-4.5" />
    </ToggleButton>
  );
};
