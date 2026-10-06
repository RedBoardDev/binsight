import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { overviewFixture } from '@test/fixtures/overview';
import { statsSeriesFixture } from '@test/fixtures/statsSeries';
import { renderAppAt } from '@test/renderAppAt';
import { errorResponse, jsonResponse, signedInSession, stubApi } from '@test/stubApi';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

describe('Overview real pnl pulse', () => {
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('uses the server time zone and reads all four exact fields with the keyboard', async () => {
    const fixture = statsSeriesFixture();
    const fetchStub = stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () => jsonResponse(200, fixture),
    });
    renderAppAt('/?period=7d');
    const slider = await screen.findByRole('slider', { name: 'Real PnL' });
    act(() => slider.focus());
    await userEvent.setup().keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      'Sep 30; Profit: plus 1.000 SOL; vs net worth: plus 2.41%; Cumulative: plus 1.000 SOL; vs net worth: plus 20.40%',
    );
    expect(screen.getByRole('img')).toHaveAccessibleName('Real PnL: plus 12.553 SOL');
    expect(screen.getByRole('table', { name: 'Real PnL' })).toHaveTextContent(
      'Sep 30; Profit: plus 1.000 SOL',
    );
    expect(slider.closest('figure')?.querySelector('svg text')?.textContent).toBe('Sep 30');
    const fetched = fetchStub.mock.calls.flatMap(([request]) =>
      request instanceof Request && new URL(request.url).pathname === '/api/v1/stats/series'
        ? [new URL(request.url)]
        : [],
    );
    expect(fetched).toHaveLength(1);
    expect(Object.fromEntries(fetched[0]?.searchParams ?? [])).toEqual({
      wallet: 'all',
      period: '7d',
      currency: 'sol',
      series: 'real_pnl',
      bucket: 'day',
    });
  });

  it('keeps masked money out of its summary slider table and readout while percentages remain visible', async () => {
    displayPreferenceStore.setAmountsHidden(true);
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
    });
    renderAppAt('/');
    const slider = await screen.findByRole('slider', { name: 'Real PnL' });
    act(() => slider.focus());
    await userEvent.setup().keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('amount hidden SOL'));
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('plus 20.40%'));
    const figure = slider.closest('figure');
    if (figure === null) throw new Error('The chart needs a figure');
    expect(figure).toHaveTextContent('•••••');
    expect(figure).not.toHaveTextContent('1.000');
    expect(screen.getByRole('img')).toHaveAccessibleName('Real PnL: plus amount hidden SOL');
    expect(screen.getByRole('table', { name: 'Real PnL' })).not.toHaveTextContent('12.553');
  });

  it('reads a day on the legend line of a phone, says why a reading is missing, then gives the legend back', async () => {
    const fixture = statsSeriesFixture();
    const unavailable = {
      exactness: 'unavailable' as const,
      reasons: [{ code: 'history_incomplete' as const, wallet: 'test-wallet', progress: null }],
    };
    const first = fixture.points[0];
    if (first === undefined) throw new Error('The fixture needs a first point');
    first.bar = null;
    first.bar_share_of_net_worth = null;
    first.line = unavailable;
    first.line_share_of_net_worth = unavailable;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () => jsonResponse(200, fixture),
    });
    renderAppAt('/');
    const slider = await screen.findByRole('slider', { name: 'Real PnL' });
    act(() => slider.focus());
    await userEvent.setup().keyboard('{Home}');
    const description = slider.getAttribute('aria-valuetext');
    expect(description).toContain('Profit: not available');
    expect(description).toContain('History still importing.');
    expect(description).not.toContain('0.000');
    const figure = slider.closest('figure');
    if (figure === null) throw new Error('The chart needs a figure');
    const caption = within(figure).getByText('Wed, Sep 30').closest('figcaption');
    expect(caption).not.toBeNull();
    expect(within(figure).queryByRole('radiogroup', { name: 'Period' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('History still importing.');
    act(() => slider.blur());
    expect(within(figure).getByText('Daily')).toBeInTheDocument();
    expect(within(figure).getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument();
  });

  it('keeps period controls usable after the explicit daily bucket limit and retries the same request', async () => {
    let attempts = 0;
    const fetchStub = stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () =>
        ++attempts === 1
          ? errorResponse(400, 'invalid_request')
          : jsonResponse(200, statsSeriesFixture()),
    });
    renderAppAt('/?period=all');
    expect(await screen.findByRole('alert')).toHaveTextContent('request');
    expect(screen.getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('slider')).toBeInTheDocument();
    const requests = fetchStub.mock.calls.flatMap(([request]) =>
      request instanceof Request && new URL(request.url).pathname === '/api/v1/stats/series'
        ? [new URL(request.url)]
        : [],
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (url) =>
          url.searchParams.get('bucket') === 'day' && url.searchParams.get('period') === 'all',
      ),
    ).toBe(true);
  });

  it('retains the last chart after a failed refresh without synthesizing fresh data', async () => {
    let hasFailed = false;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () =>
        hasFailed ? errorResponse(503, 'data_not_ready') : jsonResponse(200, statsSeriesFixture()),
    });
    const { queryClient } = renderAppAt('/');
    expect(await screen.findByRole('slider')).toBeInTheDocument();
    hasFailed = true;
    await act(() => queryClient.invalidateQueries({ queryKey: ['Stats'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('preparing');
    expect(screen.getByRole('img')).toHaveAccessibleName('Real PnL: plus 12.553 SOL');
    expect(screen.getByText('Showing previous readings.')).toBeInTheDocument();
  });

  it('keeps an empty unavailable series out of keyboard navigation without showing zero readings', async () => {
    const fixture = statsSeriesFixture();
    fixture.points = [];
    fixture.header.value = {
      exactness: 'unavailable',
      reasons: [{ code: 'missing_open_pnl_mark', wallet: 'test-wallet' }],
    };
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () => jsonResponse(200, fixture),
    });
    renderAppAt('/');
    const slider = await screen.findByRole('slider', { name: 'Real PnL' });
    expect(slider).toHaveAttribute('tabindex', '-1');
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('aria-valuetext', 'No chart values');
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Real PnL: not available. No valuation is available for the positions open at this point.',
    );
    expect(screen.getByRole('table')).not.toHaveTextContent('0.000');
  });

  it('clears a selected reading when the URL period changes', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
    });
    const { router } = renderAppAt('/');
    const slider = await screen.findByRole('slider', { name: 'Real PnL' });
    act(() => slider.focus());
    const user = userEvent.setup();
    await user.keyboard('{Home}');
    await act(() => router.navigate({ to: '/', search: { period: '7d' } }));
    expect(router.state.location.search).toMatchObject({ period: '7d' });
    expect(await screen.findByText('Daily', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '6');
    expect(screen.getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument();
  });

  it('reserves the chart while its independent query is pending', async () => {
    let finish: ((response: Response) => void) | undefined;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/overview': () => jsonResponse(200, overviewFixture()),
      'GET /api/v1/stats/series': () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    });
    renderAppAt('/');
    expect(await screen.findByRole('status', { name: 'Loading real PnL' })).toBeInTheDocument();
    expect(screen.getByText('+1.000')).toBeInTheDocument();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish?.(jsonResponse(200, statsSeriesFixture())));
    expect(await screen.findByRole('slider')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading real PnL' })).not.toBeInTheDocument();
  });
});
