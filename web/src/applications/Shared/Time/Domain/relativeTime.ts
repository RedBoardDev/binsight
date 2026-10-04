import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
} from '@app/applications/Shared/Time/Domain/timeUnits';
export type RelativeTime =
  | { readonly kind: 'just-now' }
  | {
      readonly kind: 'ago';
      readonly value: number;
      readonly unit: 'minute' | 'hour' | 'day';
    };

export const relativeTime = (elapsedSeconds: number): RelativeTime => {
  if (elapsedSeconds < SECONDS_PER_MINUTE) {
    return { kind: 'just-now' };
  }
  if (elapsedSeconds < SECONDS_PER_HOUR) {
    return { kind: 'ago', value: Math.floor(elapsedSeconds / SECONDS_PER_MINUTE), unit: 'minute' };
  }
  if (elapsedSeconds < SECONDS_PER_DAY) {
    return { kind: 'ago', value: Math.floor(elapsedSeconds / SECONDS_PER_HOUR), unit: 'hour' };
  }
  return { kind: 'ago', value: Math.floor(elapsedSeconds / SECONDS_PER_DAY), unit: 'day' };
};
