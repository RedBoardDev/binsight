/**
 * Copy-bot · coffre (Inc.4e) — classify a per-user SIGN failure so the coffre lane fires the RIGHT isolated branch
 * (SPEC §2.4, #20/#21). PURE (no I/O): the branch side effects (operator alert, heartbeat flag, signing_disabled)
 * are the caller's. Two custody failures need distinct handling; everything else is a transient/other land error:
 *  - 'outage'  (#20): Privy signing unavailable after bounded retries → PINNED "signing unavailable" alert + a
 *                     `signingAvailable:false` heartbeat flag; NO automatism (the reconcile re-publishes closes when
 *                     Privy returns; missed opens are logged — accepted risk SPEC §17.3).
 *  - 'revoked' (#21): the user revoked the coffre session signer → disable signing for THAT user + an in-app
 *                     "re-authorize or close manually" alert; the mirrors are KEPT so the reconcile still tries to
 *                     close them (never-miss — do NOT drop them).
 *  - 'other'         : any other failure → the existing bounded sign/land retry.
 * One user's outage/revocation must never affect another user (per-user isolation, SPEC §11/§17).
 */
import { APIError, AuthenticationError, PermissionDeniedError } from '@privy-io/node';
import { PrivyOutageError } from '@/copybot/coffre/signer';

export type SignErrorClass = 'outage' | 'revoked' | 'other';

/** HTTP statuses that mean "this signer is no longer authorized for this wallet" (the revoked-delegation class). */
const REVOKED_STATUS = new Set([401, 403]);

/**
 * Whether a sign error is a REVOKED-delegation failure — the user removed the coffre session signer (Privy permits
 * it, #21). The EXACT error class/string the live Privy RPC returns for a revoked signer is a devnet-only fact
 * (SPEC §2.5.5), so this ships a documented predicate: the broad, fail-safe fallback treats any authorization /
 * permission-denied Privy error (HTTP 401/403) as revoked, and a placeholder message match is refined on devnet.
 * Duck-types `.status` (like `isRetryablePrivyError`) so a plain test-double error exercises the SAME classification.
 */
export function isRevokedDelegationError(err: unknown): boolean {
  if (err instanceof PermissionDeniedError || err instanceof AuthenticationError) return true;
  const status =
    err instanceof APIError ? err.status : (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && REVOKED_STATUS.has(status)) return true;
  // TODO(devnet-4f): pin the EXACT revoked-signer error class/message from the live Privy RPC (SPEC §2.5.5) and
  // narrow to it. Until then keep the broad 401/403 fallback + this placeholder message match — fail TOWARD
  // "revoked" so a genuinely revoked user is disabled, never silently retried forever (a stuck sign is never-miss-safe
  // because the mirrors are kept and the reconcile keeps trying once the user re-authorizes).
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    message.includes('revoked') ||
    message.includes('signer not authorized') ||
    message.includes('not a signer')
  );
}

/** Classify a thrown sign error into its isolated branch. A PrivyOutageError (bounded-retry exhausted) wins first. */
export function classifySignError(err: unknown): SignErrorClass {
  if (err instanceof PrivyOutageError) return 'outage';
  if (isRevokedDelegationError(err)) return 'revoked';
  return 'other';
}
