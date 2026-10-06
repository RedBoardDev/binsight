import { buildTodayHistoryHref } from '@app/applications/Overview/Ui/OverviewPage/todayHistoryHref';
import { overviewFixture } from '@test/fixtures/overview';
import { describe, expect, it } from 'vitest';

describe('today history link', () => {
  it('uses the server today window in its own time zone instead of the gain window or the local clock', () => {
    const overview = overviewFixture();
    const window = {
      ...overview.today.window,
      start: '2026-10-05T22:00:00Z',
      timezone: 'Europe/Berlin',
    };
    expect(buildTodayHistoryHref({ window, wallet: 'all' })).toBe('/history?day=2026-10-06');
    expect(overview.gain.window.start).not.toBe(window.start);
  });

  it('preserves an explicit server day and the selected wallet', () => {
    const window = { ...overviewFixture().today.window, day: '2026-10-03' };
    expect(buildTodayHistoryHref({ window, wallet: 'test-wallet' })).toBe(
      '/history?day=2026-10-03&wallet=test-wallet',
    );
  });
});
