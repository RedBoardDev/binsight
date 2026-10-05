import { useSessionCheck } from '@app/applications/Auth/Api/useSessionCheck.api';
import { LIVE_EVENT_TYPES, parseLiveEvent } from '@app/applications/Realtime/Domain/liveEvent';
import { type RealtimeEffect, toEffects } from '@app/applications/Realtime/Domain/realtimeEffects';
import { reconnectDelay } from '@app/applications/Realtime/Domain/reconnectDelay';
import { realtimeStatusStore } from '@app/applications/Realtime/Ui/realtimeStatusStore';
import { useDisconnectedRefresh } from '@app/applications/Realtime/Ui/useDisconnectedRefresh';
import { openEventStream, type StreamState } from '@app/lib/sse/eventStream';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';

const EVENTS_URL = '/api/v1/events';
const RESYNC_JITTER_MS = 2_000;

const applyEffect = (queryClient: QueryClient, effect: RealtimeEffect): void => {
  switch (effect.kind) {
    case 'heartbeat':
      realtimeStatusStore.recordHeartbeat(effect.at);
      return;
    case 'refreshActiveQueries':
      void queryClient.invalidateQueries({ type: 'active' });
      return;
  }
};

interface RealtimeProviderProps {
  children: ReactNode;
}

export const RealtimeProvider = ({ children }: RealtimeProviderProps) => {
  const queryClient = useQueryClient();
  const checkSession = useSessionCheck();
  useDisconnectedRefresh();

  useEffect(() => {
    let hasOpened = false;
    let wasInterrupted = false;
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;

    // Events sent while the stream was down are lost: after a reconnection, refetch what is on
    // screen. The jitter keeps every open tab from refetching at the same instant.
    const onStateChange = (state: StreamState): void => {
      realtimeStatusStore.setState(state);
      if (state !== 'open') {
        wasInterrupted = hasOpened;
        return;
      }
      hasOpened = true;
      if (wasInterrupted) {
        wasInterrupted = false;
        resyncTimer = setTimeout(
          () => void queryClient.invalidateQueries({ type: 'active' }),
          Math.random() * RESYNC_JITTER_MS,
        );
      }
    };

    const stream = openEventStream({
      url: EVENTS_URL,
      eventTypes: LIVE_EVENT_TYPES,
      onEvent: (type, data) => {
        const event = parseLiveEvent(type, data);
        for (const effect of event === null ? [] : toEffects(event)) {
          applyEffect(queryClient, effect);
        }
      },
      onStateChange,
      onRefused: () => {
        checkSession().catch((error: unknown) => {
          console.warn('could not check the session after the live stream was refused', error);
        });
      },
      reconnectDelay: (attempt) => reconnectDelay(attempt, Math.random),
    });

    return () => {
      stream.close();
      clearTimeout(resyncTimer);
      realtimeStatusStore.reset();
    };
  }, [queryClient, checkSession]);

  return children;
};
