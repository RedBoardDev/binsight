import {
  reducedMotionStore,
  syncReducedMotionAttribute,
} from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stubSystemMotion = (prefersReduced: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersReduced && query === '(prefers-reduced-motion: reduce)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
};

const reduceMotionAttribute = (): string | undefined =>
  document.documentElement.dataset.reduceMotion;

describe('reducedMotionStore', () => {
  afterEach(() => reducedMotionStore.setPreference('system'));

  it('marks the page when the system reduces motion', () => {
    stubSystemMotion(true);
    const stop = syncReducedMotionAttribute();

    expect(reducedMotionStore.isReduced()).toBe(true);
    expect(reduceMotionAttribute()).toBe('true');
    stop();
  });

  it('reduces motion when the setting asks for it, and remembers it', () => {
    stubSystemMotion(false);
    const stop = syncReducedMotionAttribute();
    expect(reduceMotionAttribute()).toBeUndefined();

    reducedMotionStore.setPreference('reduce');

    expect(reduceMotionAttribute()).toBe('true');
    expect(window.localStorage.getItem('binsight.motion')).toBe('reduce');
    stop();
  });

  it('lets motion back when the setting returns to the system', () => {
    stubSystemMotion(false);
    reducedMotionStore.setPreference('reduce');
    const stop = syncReducedMotionAttribute();

    reducedMotionStore.setPreference('system');

    expect(reduceMotionAttribute()).toBeUndefined();
    stop();
  });
});
