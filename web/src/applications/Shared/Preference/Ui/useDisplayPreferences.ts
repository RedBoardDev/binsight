import type { DisplayPreferences } from '@app/applications/Shared/Preference/Domain/displayPreference';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { useSyncExternalStore } from 'react';

export const useDisplayPreferences = (): DisplayPreferences =>
  useSyncExternalStore(displayPreferenceStore.subscribe, displayPreferenceStore.getSnapshot);
