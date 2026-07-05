/**
 * Copy-bot · bus HMAC key guard (fail-closed on the money path).
 *
 * The coffre is the SOLE key holder and its only transport authentication is the bus HMAC (envelope.ts MACs
 * `${hop}\n${body}`). Shipping with the PUBLIC dev default means anyone who can reach Redis can forge `cmd:sign`
 * and get the vault to sign. So both processes MUST refuse to boot unless a real, non-default, long-enough key is
 * set — UNLESS an explicit local-dev escape (COPYBOT_DEV_BUS_KEY=true) is present. Pure + unit-tested; the callers
 * do the log + process.exit so the boot pattern stays identical to the other missing-env checks.
 */

import { createHmac } from 'node:crypto';

/** The PUBLIC placeholder shipped in the repo — never a real secret; only accepted via the explicit dev escape. */
export const DEV_DEFAULT_BUS_KEY = 'dev-k-sign-CHANGE-ME';
/** Minimum bytes for a usable HMAC key — no shorter secret is worth accepting on the signing path. */
export const MIN_BUS_KEY_LENGTH = 16;

export type BusKeyResult = { key: string } | { error: string };

/**
 * Resolve the bus HMAC key fail-closed:
 *  - BUS_HMAC_KEY set, not the dev default, and ≥ MIN_BUS_KEY_LENGTH → OK, use it.
 *  - else COPYBOT_DEV_BUS_KEY === 'true' → explicit local-dev escape, allow the public default.
 *  - else → error (missing / insecure key).
 */
export function assertBusKey(env: {
  BUS_HMAC_KEY?: string;
  COPYBOT_DEV_BUS_KEY?: string;
}): BusKeyResult {
  const key = env.BUS_HMAC_KEY;
  if (key !== undefined && key !== DEV_DEFAULT_BUS_KEY && key.length >= MIN_BUS_KEY_LENGTH) {
    return { key };
  }
  if (env.COPYBOT_DEV_BUS_KEY === 'true') {
    return { key: DEV_DEFAULT_BUS_KEY };
  }
  return {
    error: 'BUS_HMAC_KEY missing or insecure — set it, or COPYBOT_DEV_BUS_KEY=true for local dev',
  };
}

/**
 * #24 — per-hop key split. Today ONE validated BUS_HMAC_KEY authenticates BOTH hops; the envelope already binds the
 * hop into the MAC, but the KEY is shared, so a leak/confusion of one hop's material could forge the other. We split
 * the base secret into one key per hop (HKDF-Expand style): each side signs its OUTBOUND hop and verifies the OTHER
 * hop with a DISTINCT key, so leaking/confusing K_sign can never forge ev:executed (and vice versa).
 *
 * These `info` labels are the domain-separation inputs. Version-tagged so a future rotation is just a label bump.
 * STABLE functional identifiers (like reason codes) — never re-worded (that would silently rotate every key).
 */
export const HOP_KEY_INFO_SIGN = 'copybot/bus/k-sign/v1'; // K_sign — cmd:sign hop (brain SIGNs → coffre VERIFIEs)
export const HOP_KEY_INFO_EVT = 'copybot/bus/k-evt/v1'; // K_evt — ev:executed hop (coffre SIGNs → brain VERIFIEs)

/** The two per-hop keys derived from the single base secret. */
export interface HopKeys {
  /** cmd:sign hop key: the brain signs the SignRequest with it; the coffre verifies with it. */
  kSign: string;
  /** ev:executed hop key: the coffre signs the executed event with it; the brain verifies with it. */
  kEvt: string;
}

/**
 * Derive the two per-hop keys from the validated base secret — `HMAC-SHA256(baseKey, info)` per hop. Deterministic,
 * so BOTH processes, booting from the SAME BUS_HMAC_KEY, derive byte-identical kSign/kEvt (backward-verifiable within
 * one co-deploy — the brain and coffre always ship together). PURE; each `main()` calls this right after
 * `assertBusKey`, then threads kSign into the cmd:sign hop and kEvt into the ev:executed hop.
 */
export function deriveHopKeys(baseKey: string): HopKeys {
  return {
    kSign: createHmac('sha256', baseKey).update(HOP_KEY_INFO_SIGN).digest('hex'),
    kEvt: createHmac('sha256', baseKey).update(HOP_KEY_INFO_EVT).digest('hex'),
  };
}
