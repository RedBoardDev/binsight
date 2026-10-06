import { overviewFixture } from '@test/fixtures/overview';
import { statsSeriesFixture } from '@test/fixtures/statsSeries';
import { renderAppAt } from '@test/renderAppAt';
import { errorResponse, jsonResponse, signedInSession, stubApi } from '@test/stubApi';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// jsdom matches no media query, so the page renders its phone layout unless a spec asks for the
// desktop one: then the desktop query alone matches.
const DESKTOP_QUERY = '(min-width: 64rem)';
const onDesktop = (): void => {
  const unmatched = window.matchMedia(DESKTOP_QUERY);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...unmatched,
    media: query,
    matches: query === DESKTOP_QUERY,
  }));
};

const estimatedToday = () => {
  const fixture = overviewFixture();
  fixture.today.totals.pnl = {
    exactness: 'estimated',
    value: { amount: '1.0005', unit: 'sol' },
    reasons: [{ code: 'provisional_rate', day: '2026-10-06' }],
  };
  return fixture;
};

describe('OverviewPage', () => {
  it('keeps known figures when the server cannot classify the fee position count', async () => {
    const fixture = overviewFixture();
    fixture.open.unclaimed_position_count = null;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, fixture),
    });
    onDesktop();
    const { queryClient } = renderAppAt('/');
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    expect(screen.getByText('100.123')).toBeInTheDocument();
    expect(screen.getByText('+1.336')).toBeInTheDocument();
    expect(screen.getByText('+12.553')).toBeInTheDocument();
    const cached = queryClient.getQueryData<ReturnType<typeof overviewFixture>>([
      'Overview',
      2,
      'get',
      { wallet: 'all', period: '1m', currency: 'sol' },
    ]);
    expect(cached?.open.unclaimed_position_count).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('No open positions')).not.toBeInTheDocument();
  });

  it('reads the URL scope and links to the server today day', async () => {
    const fixture = overviewFixture();
    const fetchStub = stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, fixture),
    });
    onDesktop();
    renderAppAt('/?period=3m');
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    expect(screen.getByText('Gain · 3M')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /5 closes.*realized/ })).toHaveAttribute(
      'href',
      '/history?day=2026-10-06&period=3m',
    );
    const requests = fetchStub.mock.calls.flatMap(([request]) =>
      request instanceof Request && new URL(request.url).pathname === '/api/v1/overview'
        ? [new URL(request.url)]
        : [],
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('period')).toBe('3m');
    expect(requests[0]?.searchParams.get('wallet')).toBe('all');
    expect(requests[0]?.searchParams.get('currency')).toBe('sol');
  });

  it('shows a section error and retries without claiming an empty portfolio', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () =>
        ++attempts === 1
          ? errorResponse(503, 'data_not_ready')
          : jsonResponse(200, overviewFixture()),
    });
    renderAppAt('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('still preparing your figures');
    expect(screen.queryByText('Nothing closed yet today')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains the last figures after a failed refresh and allows a retry', async () => {
    let hasFailed = false;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () =>
        hasFailed ? errorResponse(503, 'data_not_ready') : jsonResponse(200, overviewFixture()),
    });
    const { queryClient } = renderAppAt('/');
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    hasFailed = true;
    await act(() => queryClient.invalidateQueries({ queryKey: ['Overview'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still preparing your figures');
    expect(screen.getByText('+1.000')).toBeInTheDocument();
    expect(screen.getByText('Data from 12:00 PM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('opens on the figures, its title kept for screen readers and the browser tab', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
    });
    onDesktop();
    renderAppAt('/');
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toHaveClass('sr-only');
    expect(screen.getByRole('heading', { level: 2, name: 'Today · since 00:00' })).toBeVisible();
    expect(document.title).toBe('Overview · binsight');
  });

  it('shows Today with its percent in a pill and three figures on one line on a phone', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
    });
    renderAppAt('/?period=3m');
    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getByText('+1.000')).toBeInTheDocument();
    expect(within(today).getByText('+2.6%').closest('.bg-gain-soft')).not.toBeNull();
    expect(screen.getByText('100.12')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getByText('15.1')).toBeInTheDocument();
    expect(screen.getByText('+1.336')).toBeInTheDocument();
    expect(screen.getByText('+12.55')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Period' })).toHaveTextContent('3M');
    expect(screen.queryByRole('link', { name: /closes/ })).not.toBeInTheDocument();
  });

  it('keeps the exactness glyph of the phone hero beside its digits, not in the screen edge', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, estimatedToday()),
    });
    renderAppAt('/');
    const today = await screen.findByRole('region', { name: 'Today' });
    const glyph = within(today).getByRole('button', { name: 'Why an estimate?' });
    expect(glyph.closest('[data-mark-position]')).toHaveAttribute('data-mark-position', 'inline');
  });

  it('hangs the exactness glyph of the desktop hero in the margin of its column', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, estimatedToday()),
    });
    onDesktop();
    renderAppAt('/');
    const today = await screen.findByRole('region', { name: 'Today' });
    const glyph = within(today).getAllByRole('button', { name: 'Why an estimate?' })[0];
    expect(glyph?.closest('[data-mark-position]')).toHaveAttribute('data-mark-position', 'hanging');
  });

  it('dates lagging figures from the data, to the minute', async () => {
    const fixture = overviewFixture();
    fixture.freshness = { as_of: '2026-10-06T14:30:00Z', state: 'lagging', lag_seconds: 180 };
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, fixture),
    });
    onDesktop();
    renderAppAt('/');
    expect(await screen.findByText('Data from 2:27 PM')).toBeInTheDocument();
    // The dimming is checked where opacity is computed: e2e/visual/overview.visual.ts.
    expect(screen.getByText('100.123')).toBeInTheDocument();
  });

  it('reserves the summary layout while the first overview is pending', async () => {
    let finish: ((response: Response) => void) | undefined;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    });
    renderAppAt('/');
    expect(await screen.findByRole('status', { name: 'Loading overview' })).toBeInTheDocument();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish?.(jsonResponse(200, overviewFixture())));
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading overview' })).not.toBeInTheDocument();
  });
});
