import { renderAppAt } from '@test/renderAppAt';
import { jsonResponse, signedInSession, signedOutSession, stubApi } from '@test/stubApi';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const HEALTHY = { status: 'ok', version: '0.1.0', database: 'ok', engine: 'running' };

const stubEventSource = () => {
  const sources: ControlledEventSource[] = [];
  class ControlledEventSource extends EventTarget {
    readonly CLOSED = 2;
    readyState = 0;

    constructor() {
      super();
      sources.push(this);
    }

    close(): void {
      this.readyState = this.CLOSED;
    }

    open(): void {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }

    send(type: string, payload: unknown): void {
      this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }

    refuse(): void {
      this.readyState = this.CLOSED;
      this.dispatchEvent(new Event('error'));
    }
  }
  vi.stubGlobal('EventSource', ControlledEventSource);
  return async (): Promise<ControlledEventSource> => {
    await waitFor(() => expect(sources).not.toHaveLength(0));
    const source = sources.at(-1);
    if (source === undefined) {
      throw new Error('the app opened no event stream');
    }
    return source;
  };
};

describe('RealtimeProvider', () => {
  it('shows the stream status and the time of the last heartbeat', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    const openedStream = stubEventSource();
    renderAppAt('/health');
    const stream = await openedStream();

    const liveStatus = (await screen.findAllByRole('status')).find((status) =>
      status.textContent?.startsWith('Live updates:'),
    );
    expect(liveStatus).toHaveTextContent('Live updates: Connecting');
    act(() => stream.open());
    expect(liveStatus).toHaveTextContent('Live updates: Live');
    expect(screen.getByText('Last heartbeat').nextSibling).toHaveTextContent('—');

    act(() => stream.send('heartbeat', { type: 'heartbeat', server_time: '2026-10-03T21:00:15Z' }));

    expect(screen.getByText('Last heartbeat').nextSibling).not.toHaveTextContent('—');
  });

  it('refreshes the health when the engine status changes', async () => {
    const getHealth = vi.fn(() => jsonResponse(200, HEALTHY));
    stubApi({ 'GET /api/v1/auth/session': signedInSession, 'GET /api/v1/health': getHealth });
    const openedStream = stubEventSource();
    renderAppAt('/health');
    const stream = await openedStream();
    await screen.findByText('Healthy');
    const callsBefore = getHealth.mock.calls.length;

    act(() => stream.send('engine_status', { type: 'engine_status', status: 'stopping' }));

    await waitFor(() => expect(getHealth.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('opens the login page when the server refuses the stream because the session ended', async () => {
    let isSignedIn = true;
    stubApi({
      'GET /api/v1/auth/session': () => (isSignedIn ? signedInSession() : signedOutSession()),
    });
    const openedStream = stubEventSource();
    const { router } = renderAppAt('/health');
    const stream = await openedStream();

    isSignedIn = false;
    act(() => stream.refuse());

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});
