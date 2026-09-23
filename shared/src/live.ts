import { z } from 'zod';
import { Base58Address } from './address';
import type { Health } from './health';
import type { LiveEvent } from './notifications';
import type { WalletState } from './portfolio';

/* ────────────────────────────────────────────────────────────────────────
 * WebSocket protocol (server ↔ client)
 * ──────────────────────────────────────────────────────────────────────── */

// Server → client messages are produced by the server and consumed by first-party clients, so they
// are a compile-time type only (no runtime schema). Inbound client → server messages ARE validated.

/** Server → client messages on /live. */
export type ServerMessage =
  | { type: 'state'; payload: WalletState }
  | { type: 'health'; payload: Health }
  | { type: 'event'; payload: LiveEvent }
  | { type: 'notify'; payload: LiveEvent }
  /** A wallet's closed history changed — refetch what depends on it. */
  | { type: 'closed_changed'; wallet: string };

/** Client → server messages. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  // scope is the whole watchlist ('all') or a single base58 wallet address — never arbitrary text.
  z.object({ type: z.literal('subscribe'), scope: z.union([z.literal('all'), Base58Address]) }),
  z.object({
    type: z.literal('presence'),
    device: z.enum(['mac', 'web']),
    active: z.boolean(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
