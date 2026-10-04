import {
  isMotionReduced,
  parseMotionPreference,
} from '@app/applications/Shared/Motion/Domain/motionPreference';
import { describe, expect, it } from 'vitest';

describe('parseMotionPreference', () => {
  it('keeps a known preference', () => {
    expect(parseMotionPreference('reduce')).toBe('reduce');
    expect(parseMotionPreference('system')).toBe('system');
  });

  it('follows the system for anything else', () => {
    expect(parseMotionPreference(null)).toBe('system');
    expect(parseMotionPreference('fast')).toBe('system');
  });
});

describe('isMotionReduced', () => {
  it('follows the system by default', () => {
    expect(isMotionReduced('system', true)).toBe(true);
    expect(isMotionReduced('system', false)).toBe(false);
  });

  it('reduces motion when asked, whatever the system says', () => {
    expect(isMotionReduced('reduce', false)).toBe(true);
    expect(isMotionReduced('reduce', true)).toBe(true);
  });
});
