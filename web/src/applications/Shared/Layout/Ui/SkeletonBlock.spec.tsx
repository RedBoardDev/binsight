import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { reducedMotionStore } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { renderWithProviders } from '@test/renderWithProviders';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

describe('SkeletonBlock', () => {
  afterEach(() => reducedMotionStore.setPreference('system'));

  it('keeps the size of what loads and stays out of the accessibility tree', () => {
    const { container } = renderWithProviders(<SkeletonBlock className="h-14 w-full" />);

    const placeholder = container.querySelector('.h-14.w-full');
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
  });

  it('shimmers, but stays still when motion is reduced', () => {
    const { container } = renderWithProviders(<SkeletonBlock className="h-14" />);
    expect(container.querySelector('.skeleton--shimmer')).not.toBeNull();

    act(() => reducedMotionStore.setPreference('reduce'));

    expect(container.querySelector('.skeleton--shimmer')).toBeNull();
    expect(container.querySelector('.skeleton--none')).not.toBeNull();
  });
});
