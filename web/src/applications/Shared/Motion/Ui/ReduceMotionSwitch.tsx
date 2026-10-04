import { reducedMotionStore } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { Description, Label, Switch } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { useSyncExternalStore } from 'react';

export const ReduceMotionSwitch = () => {
  const { t } = useLingui();
  const preference = useSyncExternalStore(
    reducedMotionStore.subscribe,
    reducedMotionStore.getPreference,
  );

  return (
    <Switch
      isSelected={preference === 'reduce'}
      onChange={(isSelected) => reducedMotionStore.setPreference(isSelected ? 'reduce' : 'system')}
      className="w-full"
    >
      <Switch.Content className="w-full justify-between gap-6">
        <span className="flex flex-col gap-0.5">
          <Label className="font-medium text-body">{t`Reduce motion`}</Label>
          <Description className="text-small">
            {t`Always on when your device asks for less motion.`}
          </Description>
        </span>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
};
