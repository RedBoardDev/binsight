import type { ThemePreference } from '@app/core/theme/themePreference';
import { themeStore } from '@app/core/theme/themeStore';
import { useSyncExternalStore } from 'react';

interface ThemePreferenceControl {
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

export const useThemePreference = (): ThemePreferenceControl => {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getPreference);

  return { preference, setPreference: themeStore.setPreference };
};
