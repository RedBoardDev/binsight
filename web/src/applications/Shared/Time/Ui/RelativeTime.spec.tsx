import { RelativeTime } from '@app/applications/Shared/Time/Ui/RelativeTime';
import { renderWithProviders } from '@test/renderWithProviders';
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('RelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('says how long ago, and keeps the exact moment', () => {
    renderWithProviders(<RelativeTime timestamp="2026-10-04T09:57:00Z" />);

    const time = screen.getByText('3 min. ago');
    expect(time).toHaveAttribute('dateTime', '2026-10-04T09:57:00Z');
  });

  it('ages with the page', () => {
    renderWithProviders(<RelativeTime timestamp="2026-10-04T09:59:40Z" />);
    expect(screen.getByText('just now')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000));

    expect(screen.getByText('1 min. ago')).toBeInTheDocument();
  });

  it('shows a dash for a timestamp it cannot read, instead of failing the page', () => {
    renderWithProviders(<RelativeTime timestamp="not a date" />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
