import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveCommandId } from './command-id';

// deriveCommandId v2 is the idempotency key (executions (user_id, command_id) INSERT ON CONFLICT before signing)
// AND the ephemeral-position seed; the VAULT re-derives it and requires commandId == deriveCommandId(userId,
// eventKey). The tests pin the EXACT algorithm (a drift would make the vault reject every command), determinism
// (same user+event never double-signs), and PER-USER distinctness (SPEC §11: the same leader event copied for two
// users must yield two ids — else user #2's copy is rejected as user #1's duplicate, ULTRACODE #25/#27).
describe('deriveCommandId v2 — per-user idempotency key (brain↔vault contract)', () => {
  it('is exactly sha256(userId + "\\n" + eventKey) in lowercase hex — the byte-for-byte contract the vault re-derives', () => {
    const eventKey = 'LEADER:POOL:open:SIG123';
    expect(deriveCommandId('system', eventKey)).toBe(
      createHash('sha256').update(`system\n${eventKey}`).digest('hex'),
    );
    // a fixed published vector — guards against a silent algorithm/encoding/separator change:
    expect(deriveCommandId('u1', 'abc')).toBe(createHash('sha256').update('u1\nabc').digest('hex'));
  });

  it('is DETERMINISTIC — the same (userId, eventKey) always yields the same id (idempotency: no double-sign on a retry)', () => {
    const eventKey = 'LEADER:5rCf:close:abcdef';
    expect(deriveCommandId('system', eventKey)).toBe(deriveCommandId('system', eventKey));
  });

  it('★ the SAME eventKey for DIFFERENT users yields DIFFERENT ids (user #2 is never rejected as user #1 duplicate)', () => {
    // WHY (SPEC §11, supersedes ADR-8): with commandId = derive(eventKey) alone, both users' copies of one leader
    // event collide into ONE executions slot — the coffre claims user #1's, then rejects user #2's as 'duplicate'
    // and user #2 silently misses the copy (ULTRACODE #25/#27). The userId in the pre-image breaks the collision.
    const eventKey = 'LEADER:POOL:open:SIG';
    expect(deriveCommandId('user-1', eventKey)).not.toBe(deriveCommandId('user-2', eventKey));
  });

  it('is DISTINCT across different eventKeys for one user (distinct events never share one idempotency slot)', () => {
    const open = deriveCommandId('system', 'LEADER:POOL:open:SIG');
    const close = deriveCommandId('system', 'LEADER:POOL:close:SIG'); // same sig, different kind
    const otherSig = deriveCommandId('system', 'LEADER:POOL:open:SIG2');
    expect(open).not.toBe(close);
    expect(open).not.toBe(otherSig);
  });

  it('★ finding #37: two DISTINCT positions closed on the SAME pool in one signature derive DISTINCT commandIds', () => {
    // WHY: a leader closing two laddered positions on one pair in ONE tx yields two DetectedEvents that route to the
    // SAME (leader, pool, action='close', signature). The OLD grammar `${leader}:${pool}:close:${sig}` gave them ONE
    // commandId → the coffre claims the first and rejects the second as a 'duplicate' → one close is MISSED (the exact
    // class #37 kills). The new grammar inserts the per-position pubkey after the action, breaking the collision.
    const leader = 'LEADER';
    const pool = 'POOL';
    const sig = 'SIG';
    const posA = 'PositionAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const posB = 'PositionBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    // NEW grammar (action at index 2, position at index 3) → DISTINCT ids → both closes claim their own slot.
    const keyA = `${leader}:${pool}:close:${posA}:${sig}`;
    const keyB = `${leader}:${pool}:close:${posB}:${sig}`;
    expect(keyA.split(':')[2]).toBe('close'); // the coffre still reads the action at index 2 (grammar contract)
    expect(deriveCommandId('u1', keyA)).not.toBe(deriveCommandId('u1', keyB));
    // …and the pre-fix pool-only grammar WOULD have collided (regression guard for the bug the fix removes).
    const oldKey = `${leader}:${pool}:close:${sig}`;
    expect(deriveCommandId('u1', oldKey)).toBe(deriveCommandId('u1', oldKey)); // no position ⇒ A and B share ONE id
  });

  it('the separator makes the pre-image unambiguous — shifting bytes between userId and eventKey changes the id', () => {
    // WHY: plain concatenation would alias ('ab','c') with ('a','bc') — two DIFFERENT (tenant, event) pairs
    // silently sharing one idempotency slot. The `\n` join (impossible inside either input) prevents it.
    expect(deriveCommandId('ab', 'c')).not.toBe(deriveCommandId('a', 'bc'));
  });

  it('always returns 64 lowercase hex chars (a valid sha256 digest)', () => {
    expect(deriveCommandId('system', 'anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('★ idx27: REJECTS a newline in either input — the injectivity invariant is ENFORCED, not just documented', () => {
    // WHY: the `\n` join is one-pre-image ONLY while neither input contains `\n`. A newline in userId/eventKey would
    // let two distinct (userId, eventKey) pairs collapse to one joined string → colliding commandIds → a copy
    // rejected as another's `executions` duplicate (a MISSED copy). Real DIDs/eventKeys carry no newline, so this is
    // a defensive fail-loud assertion: it must THROW rather than silently alias.
    expect(() => deriveCommandId('u\n1', 'evt')).toThrow(/newline/);
    expect(() => deriveCommandId('u1', 'ev\nt')).toThrow(/newline/);
    // …and the ordinary newline-free case is entirely unaffected — no false positives on real inputs.
    expect(() => deriveCommandId('system', 'LEADER:POOL:open:SIG123')).not.toThrow();
  });
});
