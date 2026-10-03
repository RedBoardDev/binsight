// Storage can throw (blocked site data, some private modes). Losing a saved preference is
// acceptable; crashing the app over it is not.

export const readPreference = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const storePreference = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`the "${key}" preference could not be saved`, error);
  }
};
