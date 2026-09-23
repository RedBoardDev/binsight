import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Notification events
 * ──────────────────────────────────────────────────────────────────────── */

export const EventKindSchema = z.enum([
  'position_open',
  'position_close',
  'oor_enter',
  'oor_duration',
  'oor_return',
  'pnl_threshold',
  'fees_threshold',
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const LiveEventSchema = z.object({
  id: z.string(),
  kind: EventKindSchema,
  wallet: z.string().nullable(),
  positionAddress: z.string().nullable(),
  pair: z.string().nullable(),
  /** human-ready title/body the clients can show directly. */
  title: z.string(),
  body: z.string(),
  /** structured numbers for rich rendering (pnlSol, feesSol, side, minutes...). */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.number().int(),
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Notification configuration (per event kind, global or per-wallet)
 * ──────────────────────────────────────────────────────────────────────── */

export const NotifModeSchema = z.enum(['single', 'bulk']);
export type NotifMode = z.infer<typeof NotifModeSchema>;

export const NotifRuleSchema = z.object({
  wallet: z.string().nullable(), // null = global default
  eventKind: EventKindSchema,
  enabled: z.boolean(),
  mode: NotifModeSchema,
  /** threshold in SOL or % depending on the kind (pnl_threshold/fees_threshold). */
  threshold: z.number().nullable(),
  /** for oor_duration: minutes out-of-range before alerting. */
  oorMinutes: z.number().int().nullable(),
});
export type NotifRule = z.infer<typeof NotifRuleSchema>;
