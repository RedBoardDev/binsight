/**
 * Copy-bot · Inc.3a — deterministic `commandId` v2 = sha256(`${userId}\n${eventKey}`). PURE, shared brain↔vault
 * (web3-free). v2 (SPEC §11, supersedes ADR-8) folds the TENANT into the derivation: the same leader event copied
 * for two users yields two DISTINCT idempotency keys — without it, user #2's command would collide with user #1's
 * in the `executions` claim and be rejected as a duplicate (ULTRACODE #25/#27).
 * Acts as the idempotency key (`executions` (user_id, command_id), INSERT ON CONFLICT before signing) AND as the
 * seed of the ephemeral position (see `ephemeral-position.ts`). The vault re-derives it from the SIGNED
 * `userId` + `eventKey` and requires `commandId == deriveCommandId(userId, eventKey)`.
 */
import { createHash } from 'node:crypto';

// `\n` joins the two derivation inputs unambiguously: neither a userId nor an eventKey may contain a newline,
// so (userId, eventKey) has ONE pre-image — plain concatenation would alias ('ab','c') with ('a','bc').
const DERIVATION_SEPARATOR = '\n';

export function deriveCommandId(userId: string, eventKey: string): string {
  // Enforce the injectivity invariant the `\n` join relies on (documented on DERIVATION_SEPARATOR): a newline inside
  // either input would let two distinct (userId, eventKey) pairs collapse to ONE joined string — aliasing their
  // commandIds and, downstream, their `executions` idempotency claim (a copy rejected as another's duplicate). DIDs
  // and eventKeys carry no newline today, so this is a defensive fail-loud guard, not a hot-path reject.
  if (userId.includes(DERIVATION_SEPARATOR) || eventKey.includes(DERIVATION_SEPARATOR)) {
    throw new Error(
      'deriveCommandId: userId/eventKey must not contain a newline (breaks idempotency-key injectivity)',
    );
  }
  return createHash('sha256').update(`${userId}${DERIVATION_SEPARATOR}${eventKey}`).digest('hex');
}
