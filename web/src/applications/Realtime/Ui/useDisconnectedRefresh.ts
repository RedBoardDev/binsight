import { useRealtimeStatus } from '@app/applications/Realtime/Ui/useRealtimeStatus';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

const REFRESH_INTERVAL_MS = 30_000;

// Without the stream, no event tells the app that data changed: poll instead until it is back.
export const useDisconnectedRefresh = (): void => {
  const queryClient = useQueryClient();
  const isOpen = useRealtimeStatus().state === 'open';

  useEffect(() => {
    if (isOpen) {
      return undefined;
    }
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({ type: 'active' });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isOpen, queryClient]);
};
