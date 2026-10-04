import { shortcutFor } from '@app/core/Shortcut/globalShortcuts';
import { describe, expect, it } from 'vitest';

const press = (key: string) => ({ key, hasModifier: false, isInEditableField: false });

describe('shortcutFor', () => {
  it('switches the currency with u and hides amounts with .', () => {
    expect(shortcutFor(press('u'))).toBe('toggle-currency');
    expect(shortcutFor(press('.'))).toBe('toggle-hidden-amounts');
  });

  it('ignores other keys', () => {
    expect(shortcutFor(press('x'))).toBeNull();
  });

  it('stays out of the way while typing or with a modifier', () => {
    expect(shortcutFor({ ...press('u'), isInEditableField: true })).toBeNull();
    expect(shortcutFor({ ...press('u'), hasModifier: true })).toBeNull();
  });
});
