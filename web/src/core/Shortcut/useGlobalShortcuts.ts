import { type GlobalShortcut, shortcutFor } from '@app/core/Shortcut/globalShortcuts';
import { useEffect, useEffectEvent } from 'react';

const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const isEditable = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    return true;
  }
  return EDITABLE_ROLES.has(target.getAttribute('role') ?? '');
};

export const useGlobalShortcuts = (actions: Record<GlobalShortcut, () => void>): void => {
  const run = useEffectEvent((shortcut: GlobalShortcut) => actions[shortcut]());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor({
        key: event.key,
        hasModifier: event.metaKey || event.ctrlKey || event.altKey,
        isInEditableField: isEditable(event.target),
      });
      if (shortcut !== null && !event.defaultPrevented) {
        event.preventDefault();
        run(shortcut);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
};
