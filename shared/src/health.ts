import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Engine / sync health
 * ──────────────────────────────────────────────────────────────────────── */

/** Per-source health for the live status indicator (hover → per-service detail). */
export const SourceStatusSchema = z.enum(['ok', 'lagging', 'down']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SourceHealthSchema = z.object({
  /** rpc | jupiter | ws */
  name: z.string(),
  status: SourceStatusSchema,
  lastOkAt: z.number().int().nullable(),
  lastErrorAt: z.number().int().nullable(),
  consecutiveErrors: z.number().int(),
  /** human-readable reason when not ok (e.g. "RPC 429", "disconnected"). */
  detail: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  wsConnected: z.boolean(),
  /** latest Solana slot the engine has observed (for indexer-lag display). */
  chainTipSlot: z.number().int().nullable().default(null),
  /** per-source breakdown the client renders on hover. */
  sources: z.array(SourceHealthSchema).default([]),
  uptimeSeconds: z.number(),
});
export type Health = z.infer<typeof HealthSchema>;
