// The keys that act on the whole app, from any page. They never fire while typing in a field, nor
// with a modifier (the browser's own shortcuts stay untouched).
export type GlobalShortcut = 'toggle-currency' | 'toggle-hidden-amounts';

const SHORTCUT_KEYS: Readonly<Record<string, GlobalShortcut>> = {
  u: 'toggle-currency',
  '.': 'toggle-hidden-amounts',
};

export interface KeyPress {
  readonly key: string;
  readonly hasModifier: boolean;
  readonly isInEditableField: boolean;
}

export const shortcutFor = (press: KeyPress): GlobalShortcut | null => {
  if (press.hasModifier || press.isInEditableField) {
    return null;
  }
  return SHORTCUT_KEYS[press.key] ?? null;
};
