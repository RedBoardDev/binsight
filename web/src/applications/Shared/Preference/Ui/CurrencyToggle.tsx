import { isCurrency } from '@app/applications/Shared/Preference/Domain/displayPreference';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { useDisplayPreferences } from '@app/applications/Shared/Preference/Ui/useDisplayPreferences';
import { SolanaMark } from '@app/applications/Shared/Unit/Ui/SolanaMark';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { SelectionIndicator } from 'react-aria-components';

export const CurrencyToggle = () => {
  const { t } = useLingui();
  const { currency } = useDisplayPreferences();

  return (
    <ToggleButtonGroup
      aria-label={t`Currency`}
      selectionMode="single"
      disallowEmptySelection
      size="sm"
      selectedKeys={[currency]}
      onSelectionChange={(keys) => {
        const [selected] = keys;
        if (isCurrency(selected)) {
          displayPreferenceStore.setCurrency(selected);
        }
      }}
    >
      <ToggleButton id="sol" isIconOnly aria-label={t`Amounts in SOL`} className="h-7 w-9">
        <SelectionIndicator className="segment-indicator" />
        <SolanaMark size="column-header" />
      </ToggleButton>
      <ToggleButton
        id="usd"
        isIconOnly
        aria-label={t`Amounts in dollars`}
        className="h-7 w-9 font-semibold text-meta"
      >
        <SelectionIndicator className="segment-indicator" />$
      </ToggleButton>
    </ToggleButtonGroup>
  );
};
