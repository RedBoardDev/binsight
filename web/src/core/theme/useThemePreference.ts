import { withViewTransition } from '@app/applications/Shared/Motion/Ui/viewTransition';
import type { ThemePreference } from '@app/core/theme/themePreference';
import { themeStore } from '@app/core/theme/themeStore';
import { useSyncExternalStore } from 'react';

interface ThemePreferenceControl {
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

export const useThemePreference = (): ThemePreferenceControl => {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getPreference);
  const setPreference = (next: ThemePreference): void =>
    withViewTransition('theme', () => themeStore.setPreference(next));

  return { preference, setPreference };
};
