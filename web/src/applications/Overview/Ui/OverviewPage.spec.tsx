import { overviewFixture } from '@test/fixtures/overview';
import { statsSeriesFixture } from '@test/fixtures/statsSeries';
import { renderAppAt } from '@test/renderAppAt';
import { errorResponse, jsonResponse, signedInSession, stubApi } from '@test/stubApi';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('OverviewPage', () => {
  it('keeps known figures when the server cannot classify the fee position count', async () => {
    const fixture = overviewFixture();
    fixture.open.unclaimed_position_count = null;
    stubApi({
      'GET /api/v1/auth/session': signedInSession,
      'GET /api/v1/stats/series': () => jsonResponse(200, statsSeriesFixture()),
      'GET /api/v1/overview': () => jsonResponse(200, fixture),
    });
    const { queryClient } = renderAppAt('/');
    expect(await screen.findByText('+1.000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show net worth breakdown' })).toBeInTheDocument();
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
