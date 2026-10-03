import { type HeroUIToastOptions, toast as heroToast } from '@heroui/react';
import type { ReactNode } from 'react';

const NOTICE_TIMEOUT_MS = 6_000;
const ERROR_TIMEOUT_MS = 10_000;

type ToastOptions = Omit<HeroUIToastOptions, 'variant'>;

// Merge with `??`, never `||`: `timeout: 0` means "stay open until closed", and `||` would quietly
// turn such a toast into one that disappears.
const withTimeout = (options: ToastOptions | undefined, timeout: number): ToastOptions => ({
  ...options,
  timeout: options?.timeout ?? timeout,
});

export const toast = {
  success: (message: ReactNode, options?: ToastOptions): string =>
    heroToast.success(message, withTimeout(options, NOTICE_TIMEOUT_MS)),
  info: (message: ReactNode, options?: ToastOptions): string =>
    heroToast.info(message, withTimeout(options, NOTICE_TIMEOUT_MS)),
  warning: (message: ReactNode, options?: ToastOptions): string =>
    heroToast.warning(message, withTimeout(options, NOTICE_TIMEOUT_MS)),
  danger: (message: ReactNode, options?: ToastOptions): string =>
    heroToast.danger(message, withTimeout(options, ERROR_TIMEOUT_MS)),
  close: (key: string): void => heroToast.close(key),
};
