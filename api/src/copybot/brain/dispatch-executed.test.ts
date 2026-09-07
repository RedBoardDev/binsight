import { describe, expect, it, vi } from 'vitest';
import {
  dispatchExecuted,
  type ExecutedBatchDeps,
  type ExecutedMessage,
  isRetryableContinuationError,
  leaderOfClosingPosition,
  processExecutedBatch,
  runContinuation,
  settleContinuationFailure,
  TerminalContinuationError,
} from './dispatch-executed';

// A full set of stub handlers (all no-ops / not-pending by default); each test overrides what it asserts on.
function makeDeps(over: Partial<ExecutedBatchDeps> = {}): ExecutedBatchDeps {
  return {
    onCloseConfirmed: vi.fn(async () => {}),
    onCloseExecuted: vi.fn(async () => {}),
    hasPendingReshapeAdd: vi.fn(() => false),
    publishReshapeAddAfterBuy: vi.fn(async () => {}),
    publishTwoSidedOpenAfterBuy: vi.fn(async () => {}),
    hasPendingToken2022Deposit: vi.fn(() => false),
    publishDepositAfterPositionCreated: vi.fn(async () => {}),
    onOpenConfirmed: vi.fn(() => {}),
    hasPendingToken2022Mirror: vi.fn(() => false),
    finalizeToken2022Open: vi.fn(async () => {}),
    onAddConfirmed: vi.fn(() => {}),
    onClaimConfirmed: vi.fn(() => {}),
    onSellConfirmed: vi.fn(async () => {}),
    ack: vi.fn(async () => {}),
    onLoopError: vi.fn(() => {}),
    onUndispatched: vi.fn(() => {}),
    ...over,
  };
}

describe('dispatchExecuted — routes each ev:executed kind to its handler', () => {
  it('close → onCloseConfirmed (prompt markClosed) THEN onCloseExecuted (residual sell), userId threaded', async () => {
    // WHY: a landed close must both mark the DB closed AND trigger the residual sell — the fast path, not the 30s
    // reconcile. The coffre's `userId` (3b) must reach BOTH callbacks so the brain routes the confirm to the
    // OWNING runtime (a close attributed to the wrong tenant would corrupt another user's mirror state).
    const deps = makeDeps();
    await dispatchExecuted(
      { kind: 'close', pool: 'P', positionPubkey: 'OUR', commandId: 'C', userId: 'U1' },
      deps,
    );
    expect(deps.onCloseConfirmed).toHaveBeenCalledWith('OUR', 'U1');
    expect(deps.onCloseExecuted).toHaveBeenCalledWith({
      pool: 'P',
      positionPubkey: 'OUR',
      commandId: 'C',
      userId: 'U1',
    });
  });

  it('buy with a pending reshape add → publishReshapeAddAfterBuy (not the open path)', async () => {
    const deps = makeDeps({ hasPendingReshapeAdd: vi.fn(() => true) });
    await dispatchExecuted({ kind: 'buy', commandId: 'C', sig: 'BUYSIG' }, deps);
    expect(deps.publishReshapeAddAfterBuy).toHaveBeenCalledWith('C', 'BUYSIG'); // #140 — the buy sig reaches the publisher (BUY ledger row)
    expect(deps.publishTwoSidedOpenAfterBuy).not.toHaveBeenCalled();
  });

  it('buy with NO pending reshape add → publishTwoSidedOpenAfterBuy', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'buy', commandId: 'C', sig: 'BUYSIG' }, deps);
    expect(deps.publishTwoSidedOpenAfterBuy).toHaveBeenCalledWith('C', 'BUYSIG'); // #140 — the buy sig reaches the publisher (BUY ledger row)
    expect(deps.publishReshapeAddAfterBuy).not.toHaveBeenCalled();
  });

  it('open with a pending Token-2022 deposit → publishDepositAfterPositionCreated (not the classic confirm)', async () => {
    const deps = makeDeps({ hasPendingToken2022Deposit: vi.fn(() => true) });
    await dispatchExecuted({ kind: 'open', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.publishDepositAfterPositionCreated).toHaveBeenCalledWith('C');
    expect(deps.onOpenConfirmed).not.toHaveBeenCalled();
  });

  it('classic open (no pending deposit) → onOpenConfirmed', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'open', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.onOpenConfirmed).toHaveBeenCalledWith('OUR');
    expect(deps.publishDepositAfterPositionCreated).not.toHaveBeenCalled();
  });

  it('add with a pending Token-2022 mirror → finalizeToken2022Open (not the reshape confirm)', async () => {
    const deps = makeDeps({ hasPendingToken2022Mirror: vi.fn(() => true) });
    await dispatchExecuted({ kind: 'add', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.finalizeToken2022Open).toHaveBeenCalledWith('C');
    expect(deps.onAddConfirmed).not.toHaveBeenCalled();
  });

  it('classic reshape add → onAddConfirmed', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'add', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.onAddConfirmed).toHaveBeenCalledWith('OUR', 'C');
    expect(deps.finalizeToken2022Open).not.toHaveBeenCalled();
  });

  it('claim → onClaimConfirmed; sell → onSellConfirmed', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'claim', positionPubkey: 'OUR', commandId: 'C' }, deps);
    await dispatchExecuted({ kind: 'sell', commandId: 'S', pool: 'P' }, deps);
    expect(deps.onClaimConfirmed).toHaveBeenCalledWith('OUR', 'C');
    expect(deps.onSellConfirmed).toHaveBeenCalledWith({ kind: 'sell', commandId: 'S', pool: 'P' });
  });

  it('null / unknown-kind payload → no handler called (defensive no-op), returns false (unrouted → reported #25)', async () => {
    // WHY (#25): the boolean return is how the caller learns a message hit NO branch (a null HMAC-fail payload or an
    // unknown kind) so it can record it loudly instead of silently acking it. This test fails if either stops being false.
    const deps = makeDeps();
    expect(await dispatchExecuted(null, deps)).toBe(false);
    expect(await dispatchExecuted({ kind: 'mystery' }, deps)).toBe(false);
    expect(deps.onCloseConfirmed).not.toHaveBeenCalled();
    expect(deps.onSellConfirmed).not.toHaveBeenCalled();
  });

  it('re-delivered buy whose pending entry is gone → publish handler no-ops (idempotent replay)', async () => {
    // WHY: after a PEL-drain retry, the deferred-publish handler must be a clean no-op (delete-on-use map already
    // consumed) — dispatch still routes to it; the handler itself no-ops. Here we assert routing + no throw.
    const publishTwoSidedOpenAfterBuy = vi.fn(async () => {}); // real handler no-ops when the map entry is absent
    const deps = makeDeps({ publishTwoSidedOpenAfterBuy });
    await expect(
      dispatchExecuted({ kind: 'buy', commandId: 'ALREADY-DONE', sig: 'BUYSIG' }, deps),
    ).resolves.toBe(true); // still ROUTED (returns true) — the publish handler itself no-ops; only the return signal is new
    expect(publishTwoSidedOpenAfterBuy).toHaveBeenCalledWith('ALREADY-DONE', 'BUYSIG');
  });

  it('a throwing handler makes dispatch REJECT (so the batch guard can isolate it)', async () => {
    const boom = new Error('db blip in markClosed');
    const deps = makeDeps({
      onCloseConfirmed: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(
      dispatchExecuted({ kind: 'close', pool: 'P', positionPubkey: 'OUR' }, deps),
    ).rejects.toBe(boom);
  });
});

describe('processExecutedBatch — per-message isolation + non-ack-on-throw (no-miss)', () => {
  const msg = (id: string, payload: unknown): ExecutedMessage => ({ id, payload });

  it('one throwing message does NOT abort the batch: its mates are still processed AND acked', async () => {
    // WHY (the #8 bug): a throwing handler previously escaped the for-loop → the whole batch backed off and the
    // delivered messages were never acked → confirmations stranded in the PEL forever. Each message must be isolated.
    const onCloseConfirmed = vi.fn(async (our: string) => {
      if (our === 'BAD') throw new Error('db blip');
    });
    const deps = makeDeps({ onCloseConfirmed });
    const batch: ExecutedMessage[] = [
      msg('1', { kind: 'close', pool: 'P', positionPubkey: 'OK1' }),
      msg('2', { kind: 'close', pool: 'P', positionPubkey: 'BAD' }),
      msg('3', { kind: 'sell', commandId: 'S', pool: 'P' }),
    ];
    await processExecutedBatch(batch, deps);

    // The good close (1) and the sell (3) were fully handled and acked.
    expect(deps.onCloseConfirmed).toHaveBeenCalledWith('OK1', undefined); // userId absent on this legacy payload
    expect(deps.onSellConfirmed).toHaveBeenCalledTimes(1);
    expect(deps.ack).toHaveBeenCalledWith('1');
    expect(deps.ack).toHaveBeenCalledWith('3');
    // The throwing message (2) was recorded as a loop error and deliberately NOT acked → recovered by the next PEL drain.
    expect(deps.onLoopError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.onLoopError).mock.calls[0]?.[1]).toBe('2');
    expect(deps.ack).not.toHaveBeenCalledWith('2');
  });

  it('a failing ack is isolated to its own message (left unACKed) without aborting the batch', async () => {
    // WHY: an ack blip must not skip the rest of the batch nor mark the message done — the PEL drain retries it.
    const ack = vi.fn(async (id: string) => {
      if (id === '1') throw new Error('redis blip on ack');
    });
    const deps = makeDeps({ ack });
    await processExecutedBatch(
      [msg('1', { kind: 'sell', commandId: 'S1' }), msg('2', { kind: 'sell', commandId: 'S2' })],
      deps,
    );
    expect(deps.onSellConfirmed).toHaveBeenCalledTimes(2); // both dispatched
    expect(deps.onLoopError).toHaveBeenCalledTimes(1); // only msg 1's ack failed
    expect(deps.ack).toHaveBeenCalledWith('2');
  });

  it('a drained PEL message that is now a no-op is acked (idempotent recovery, not re-stranded)', async () => {
    // WHY: the PEL drain re-delivers a message that already succeeded; its handler no-ops and the batch acks it so
    // it leaves the PEL for good (no infinite redelivery).
    const deps = makeDeps(); // publishTwoSidedOpenAfterBuy is a no-op stub (map entry already consumed)
    await processExecutedBatch([msg('9', { kind: 'buy', commandId: 'DONE', sig: 'BUYSIG' })], deps);
    expect(deps.publishTwoSidedOpenAfterBuy).toHaveBeenCalledWith('DONE', 'BUYSIG');
    expect(deps.ack).toHaveBeenCalledWith('9');
    expect(deps.onLoopError).not.toHaveBeenCalled();
  });

  it('a null payload (failed HMAC/hop) is recorded LOUDLY as unauthenticated, THEN acked (never silently dropped)', async () => {
    // WHY (finding #25): a MAC/hop mismatch yields a null payload no branch consumes. The old code just acked it
    // away with no trace; now it is recorded (observable) BEFORE the ack removes it from the PEL — like the coffre.
    const deps = makeDeps();
    await processExecutedBatch([msg('7', null)], deps);
    expect(deps.onUndispatched).toHaveBeenCalledWith('unauthenticated', '7');
    expect(deps.ack).toHaveBeenCalledWith('7'); // acked AFTER the loud record — a poison message must not redeliver forever
    expect(deps.onLoopError).not.toHaveBeenCalled();
  });

  it('an unknown-kind payload is recorded LOUDLY as unknown_kind, THEN acked', async () => {
    const deps = makeDeps();
    await processExecutedBatch([msg('8', { kind: 'mystery' })], deps);
    expect(deps.onUndispatched).toHaveBeenCalledWith('unknown_kind', '8');
    expect(deps.ack).toHaveBeenCalledWith('8');
  });

  it('a normally-routed message is NOT reported as undispatched', async () => {
    const deps = makeDeps();
    await processExecutedBatch([msg('9', { kind: 'sell', commandId: 'S' })], deps);
    expect(deps.onUndispatched).not.toHaveBeenCalled();
    expect(deps.ack).toHaveBeenCalledWith('9');
  });

  it('empty batch → nothing happens (no ack, no error)', async () => {
    const deps = makeDeps();
    await processExecutedBatch([], deps);
    expect(deps.ack).not.toHaveBeenCalled();
    expect(deps.onLoopError).not.toHaveBeenCalled();
  });
});

describe('deferred-continuation retry semantics (finding #137 — never drop an open after our buy landed)', () => {
  it('isRetryableContinuationError: a transient error is retryable; a TerminalContinuationError is not', () => {
    // WHY: the split decides ACK vs un-ACK. Mis-classifying a transient RPC/DB error as terminal DROPS an open after
    // our buy already spent real SOL (forbidden). So the default is "retry"; only a known-deterministic build failure
    // is terminal. This test fails if the default ever flips to "terminal" (which would silently drop opens).
    expect(isRetryableContinuationError(new Error('RPC 429 Too Many Requests'))).toBe(true);
    expect(isRetryableContinuationError(new TypeError('cannot read x'))).toBe(true);
    expect(isRetryableContinuationError(new TerminalContinuationError('range too wide'))).toBe(
      false,
    );
  });

  it('runContinuation: a resolved body DROPS the retry token (the continuation settled → ACK)', async () => {
    const stash = new Map<string, number>([['K', 1]]);
    let ran = false;
    await runContinuation(stash, 'K', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(stash.has('K')).toBe(false);
  });

  it('runContinuation: a TRANSIENT throw KEEPS the token and rethrows (→ un-ACK → PEL retry re-runs it, open NOT lost)', async () => {
    // The core of finding #137: the token is the retry handle. A transient failure must leave it in place so the
    // un-ACKed ev:executed message re-drives the continuation — otherwise the open bought with real SOL is dropped.
    const stash = new Map<string, number>([['K', 1]]);
    const boom = new Error('createDlmmPair 429');
    await expect(
      runContinuation(stash, 'K', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(stash.has('K')).toBe(true); // token intact → the continuation is retried, never abandoned
  });

  it('runContinuation: a DETERMINISTIC (Terminal) throw DROPS the token and rethrows (→ *_failed + ACK, no poison loop)', async () => {
    // A permanently-invalid shape must NOT hold the message for an endless PEL retry: drop the token so it acks out,
    // but still rethrow so the consumer emits the *_failed feed row.
    const stash = new Map<string, number>([['K', 1]]);
    const term = new TerminalContinuationError('deposit chunked into 2 txs (range too wide)');
    await expect(
      runContinuation(stash, 'K', async () => {
        throw term;
      }),
    ).rejects.toBe(term);
    expect(stash.has('K')).toBe(false); // token dropped → never poison-retried
  });

  it('settleContinuationFailure: a TRANSIENT error RETHROWS (leaves the message un-ACKed) and does NOT emit *_failed', () => {
    const onTerminal = vi.fn();
    const boom = new Error('db blip in saveOpen');
    expect(() => settleContinuationFailure(boom, onTerminal)).toThrow(boom);
    expect(onTerminal).not.toHaveBeenCalled(); // not a failure — it will be retried
  });

  it('settleContinuationFailure: a DETERMINISTIC error emits *_failed (message ACKs) and does NOT rethrow', () => {
    const onTerminal = vi.fn();
    expect(() =>
      settleContinuationFailure(new TerminalContinuationError('too wide'), onTerminal),
    ).not.toThrow();
    expect(onTerminal).toHaveBeenCalledTimes(1); // emit the feed row + let the message ACK (no infinite retry)
  });
});

describe('leaderOfClosingPosition — the real leader of the closing mirror (finding #60, multi-leader alerts)', () => {
  const leaderOf = (m: { leaderAddress: string }): string => m.leaderAddress || 'BOOT_LEADER';

  it("returns the CLOSING mirror's leader (not the demoted default) so a multi-leader swap-failed alert is labeled right", () => {
    // WHY (#60): once >1 leader is copied, hardcoding cfg.leader mislabels a failed close-residual-sell alert. The
    // mirror row (which survives markClosed) carries the true leader; this test fails if the label reverts to the default.
    const registry = {
      getByOurPosition: (o: string) => (o === 'OUR' ? { leaderAddress: 'LEADER_B' } : undefined),
    };
    expect(leaderOfClosingPosition(registry, leaderOf, 'OUR', 'CFG_DEFAULT')).toBe('LEADER_B');
  });

  it('falls back to the default leader when the position is unknown or undefined (deploy-window legacy close)', () => {
    const registry = { getByOurPosition: () => undefined };
    expect(leaderOfClosingPosition(registry, leaderOf, 'MISSING', 'CFG_DEFAULT')).toBe(
      'CFG_DEFAULT',
    );
    expect(leaderOfClosingPosition(registry, leaderOf, undefined, 'CFG_DEFAULT')).toBe(
      'CFG_DEFAULT',
    );
  });

  it('applies leaderOf, so a legacy blank leaderAddress resolves to the runtime boot-leader (never an empty label)', () => {
    const registry = { getByOurPosition: () => ({ leaderAddress: '' }) };
    expect(leaderOfClosingPosition(registry, leaderOf, 'OUR', 'CFG_DEFAULT')).toBe('BOOT_LEADER');
  });
});
