import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Runtime settings (owner-only, overridable without a redeploy via /config/settings)
 * ──────────────────────────────────────────────────────────────────────── */

export const RuntimeSettingsSchema = z.object({
  /** Bark device key for the push fallback ('' disables it). Defaults to BARK_KEY from the env. */
  barkKey: z.string(),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
