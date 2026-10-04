import {
  CURRENCY_STORAGE_KEY,
  type Currency,
  type DisplayPreferences,
  HIDDEN_AMOUNTS_STORAGE_KEY,
  otherCurrency,
  parseDisplayPreferences,
  serializeAmountsHidden,
} from '@app/applications/Shared/Preference/Domain/displayPreference';
import { readPreference, storePreference } from '@app/core/preferenceStorage';

interface DisplayPreferenceStore {
  readonly getSnapshot: () => DisplayPreferences;
  readonly subscribe: (onChange: () => void) => () => void;
  readonly setCurrency: (currency: Currency) => void;
  readonly toggleCurrency: () => void;
  readonly setAmountsHidden: (areAmountsHidden: boolean) => void;
  readonly toggleAmountsHidden: () => void;
}

const readStoredPreferences = (): DisplayPreferences =>
  parseDisplayPreferences({
    currency: readPreference(CURRENCY_STORAGE_KEY),
    areAmountsHidden: readPreference(HIDDEN_AMOUNTS_STORAGE_KEY),
  });

export const createDisplayPreferenceStore = (): DisplayPreferenceStore => {
  let preferences = readStoredPreferences();
  const listeners = new Set<() => void>();

  // Each change makes a new object: useSyncExternalStore compares snapshots by identity.
  const update = (next: DisplayPreferences): void => {
    preferences = next;
    storePreference(CURRENCY_STORAGE_KEY, next.currency);
    storePreference(HIDDEN_AMOUNTS_STORAGE_KEY, serializeAmountsHidden(next.areAmountsHidden));
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => preferences,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    setCurrency: (currency) => update({ ...preferences, currency }),
    toggleCurrency: () => update({ ...preferences, currency: otherCurrency(preferences.currency) }),
    setAmountsHidden: (areAmountsHidden) => update({ ...preferences, areAmountsHidden }),
    toggleAmountsHidden: () =>
      update({ ...preferences, areAmountsHidden: !preferences.areAmountsHidden }),
  };
};

export const displayPreferenceStore = createDisplayPreferenceStore();
