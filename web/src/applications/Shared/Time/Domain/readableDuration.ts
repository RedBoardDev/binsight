import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
} from '@app/applications/Shared/Time/Domain/timeUnits';
export interface DurationParts {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
}

export type ReadableDuration =
  | { readonly kind: 'under-a-minute' }
  | { readonly kind: 'parts'; readonly parts: DurationParts };

const DAYS_ONLY_FROM = 3;

const withoutZero = (parts: DurationParts): DurationParts =>
  Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== 0));

export const readableDuration = (totalSeconds: number): ReadableDuration => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < SECONDS_PER_MINUTE) {
    return { kind: 'under-a-minute' };
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  if (days >= DAYS_ONLY_FROM) {
    return { kind: 'parts', parts: { days } };
  }
  if (days > 0) {
    return { kind: 'parts', parts: withoutZero({ days, hours }) };
  }
  if (hours > 0) {
    return { kind: 'parts', parts: withoutZero({ hours, minutes }) };
  }
  return { kind: 'parts', parts: { minutes } };
};
