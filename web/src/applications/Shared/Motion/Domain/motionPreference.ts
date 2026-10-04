export const MOTION_PREFERENCES = ['system', 'reduce'] as const;

export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const MOTION_STORAGE_KEY = 'binsight.motion';

export const isMotionPreference = (value: unknown): value is MotionPreference =>
  typeof value === 'string' && (MOTION_PREFERENCES as readonly string[]).includes(value);

export const parseMotionPreference = (stored: string | null): MotionPreference =>
  isMotionPreference(stored) ? stored : 'system';

export const isMotionReduced = (
  preference: MotionPreference,
  systemPrefersReducedMotion: boolean,
): boolean => preference === 'reduce' || systemPrefersReducedMotion;
