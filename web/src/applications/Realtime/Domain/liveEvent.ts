import { z } from 'zod/mini';

const heartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  server_time: z.iso.datetime(),
});

const engineStatusSchema = z.object({
  type: z.literal('engine_status'),
  status: z.enum(['starting', 'running', 'stopping']),
});

const walletSyncChangedSchema = z.object({
  type: z.literal('wallet_sync_changed'),
  wallet: z.string(),
  state: z.enum(['importing', 'live', 'lagging', 'error']),
});

const liveEventSchema = z.discriminatedUnion('type', [
  heartbeatSchema,
  engineStatusSchema,
  walletSyncChangedSchema,
]);

export type LiveEvent = z.infer<typeof liveEventSchema>;

export const LIVE_EVENT_TYPES = ['heartbeat', 'engine_status', 'wallet_sync_changed'] as const;

const parseJson = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

// A frame that is not valid JSON, or whose payload does not match its event name, is dropped:
// one bad frame must not break the stream.
export const parseLiveEvent = (type: string, data: string): LiveEvent | null => {
  const result = liveEventSchema.safeParse(parseJson(data));
  return result.success && result.data.type === type ? result.data : null;
};
