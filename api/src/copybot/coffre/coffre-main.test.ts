import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { CODE_REGISTRY } from '@/domain/copybot/observability/codes';
import type { ConsumedMessage } from '@/infrastructure/bus/redis-bus';
import {
  createMessageHandler,
  deadLetterCode,
  type MessageHandlerDeps,
  routeVerdict,
} from './coffre-main';
import { laneKeyOf, SigningLanes } from './lanes';

// FIX A — DLQ routing for rejected/poison cmd:sign verdicts. These pure helpers decide what the vault loop does with
// a processed message; the loop performs the I/O (ack / dead-letter / leave pending). Encodes the WHY: a poison/forged
// message must be quarantined with a durable trace (never a silent ack), and only a forged/malformed command pages the
// operator out-of-band — an expected duplicate/stale under retries must NOT.

describe('coffre routeVerdict — what the loop does with a verdict', () => {
  it('retryLater (#7 recovery in-flight) → RETAIN: leave UNACKED, NEVER dead-lettered (a prior broadcast may still land)', () => {
    expect(routeVerdict({ ok: false, reason: 'recover_in_flight', retryLater: true })).toEqual({
      action: 'retain',
    });
    // retryLater wins even over an ok flag — it must stay in the PEL for a later chain re-check.
    expect(routeVerdict({ ok: true, retryLater: true })).toEqual({ action: 'retain' });
  });

  it('terminal-OK (landed / skipped / dry-run) → ACK, as before', () => {
    expect(routeVerdict({ ok: true, reason: 'dry-run' })).toEqual({ action: 'ack' });
    expect(routeVerdict({ ok: true })).toEqual({ action: 'ack' });
  });

  it('rejected (!ok) → DEAD-LETTER: durable quarantine + trace, never a silent ack', () => {
    const route = routeVerdict({ ok: false, reason: 'bad_hmac_or_hop' });
    expect(route.action).toBe('deadLetter');
  });
});

describe('coffre deadLetterCode — pinned differentiation of the dead-letter trace', () => {
  const POISON = [
    'bad_hmac_or_hop',
    'bad_schema',
    'commandId_mismatch',
    'owner_mismatch',
    'undecodable_tx',
  ];
  const BENIGN = ['duplicate', 'stale'];

  it('forged / tampered / malformed → the dedicated pinned `system.command_quarantined` (NOT system.fatal — the process is alive)', () => {
    for (const reason of POISON) {
      const code = deadLetterCode(reason);
      // The truthful code: pinned (operator paged out-of-band) but NOT the "Bot Stopped" fatal — a single message
      // was quarantined while the vault keeps running. Fail-against-old: the prior `system.fatal` mapping is wrong.
      expect(code, reason).toBe('system.command_quarantined');
      expect(code, reason).not.toBe('system.fatal');
      expect(CODE_REGISTRY[code].pinned).toBe(true);
    }
  });

  it('benign / expected (duplicate, stale) → a NON-pinned internal trace (no false operator page under retries)', () => {
    for (const reason of BENIGN) {
      const code = deadLetterCode(reason);
      expect(code, reason).toBe('system.loop_errored');
      expect(CODE_REGISTRY[code].pinned ?? false).toBe(false);
      expect(CODE_REGISTRY[code].audience).toBe('internal');
    }
  });

  it('an unknown / undefined reason → non-pinned trace (fail-safe: never a spurious operator page)', () => {
    expect(CODE_REGISTRY[deadLetterCode(undefined)].pinned ?? false).toBe(false);
    expect(CODE_REGISTRY[deadLetterCode('some_future_reason')].pinned ?? false).toBe(false);
  });
});

// 3c — the LANE TASK (createMessageHandler): a message's ACK/dead-letter happens ONLY when its own task reaches a
// terminal outcome, never at dispatch time. Encodes the crash-recovery WHY: everything not yet terminal must remain
// in the PEL so the boot drain re-drives it.
const silentLog = pino({ level: 'silent' });

function msgOf(id: string, payload: unknown): ConsumedMessage {
  return { id, payload, raw: { body: 'b', hmac: 'h' } };
}

function depsOf(process: MessageHandlerDeps['process']): MessageHandlerDeps & {
  acks: ReturnType<typeof vi.fn>;
  dlq: ReturnType<typeof vi.fn>;
  sys: ReturnType<typeof vi.fn>;
} {
  const acks = vi.fn(async () => {});
  const dlq = vi.fn(async () => {});
  const sys = vi.fn();
  return {
    process,
    bus: { ack: acks, deadLetter: dlq } as unknown as MessageHandlerDeps['bus'],
    events: { system: sys } as unknown as MessageHandlerDeps['events'],
    log: silentLog,
    stream: 's',
    group: 'g',
    acks,
    dlq,
    sys,
  };
}

describe('coffre createMessageHandler — ACK only AFTER the lane task reached a terminal outcome', () => {
  it('★ no ack while the task is still running — a crash mid-task leaves the message in the PEL', async () => {
    // WHY: with lanes the loop DISPATCHES instead of processing inline; if the dispatch itself ACKed, a crash
    // between enqueue and terminal outcome would silently drop the command (gone from the PEL) — a missed copy.
    // We simulate the crash window by simply never resolving the task: no ack may have happened.
    let finish!: (v: { ok: boolean }) => void;
    const deps = depsOf(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const handle = createMessageHandler(deps);
    const running = handle(msgOf('1-0', { userId: 'u' }), false);
    await Promise.resolve();
    expect(deps.acks).not.toHaveBeenCalled(); // ← the PEL still owns the message here
    expect(deps.dlq).not.toHaveBeenCalled();
    finish({ ok: true }); // the task reaches its terminal outcome…
    await running;
    expect(deps.acks).toHaveBeenCalledTimes(1); // …and ONLY now is it acked
  });

  it('retain (#7 recovery in-flight) → neither acked nor dead-lettered (stays pending for a later pass)', async () => {
    const deps = depsOf(async () => ({ ok: false, reason: 'recover_in_flight', retryLater: true }));
    await createMessageHandler(deps)(msgOf('1-1', { userId: 'u' }), true);
    expect(deps.acks).not.toHaveBeenCalled();
    expect(deps.dlq).not.toHaveBeenCalled();
  });

  it('rejected → dead-lettered (which acks internally) + a durable system trace, never a silent ack', async () => {
    const deps = depsOf(async () => ({ ok: false, reason: 'bad_schema' }));
    await createMessageHandler(deps)(msgOf('1-2', null), false);
    expect(deps.dlq).toHaveBeenCalledTimes(1);
    expect(deps.acks).not.toHaveBeenCalled(); // deadLetter carries its own ack — no double path
    expect(deps.sys).toHaveBeenCalledTimes(1);
  });

  it('a process throw (transient I/O) → no ack (retry via PEL) + a loop_errored trace, and never rejects', async () => {
    const deps = depsOf(async () => {
      throw new Error('rpc blip');
    });
    await expect(
      createMessageHandler(deps)(msgOf('1-3', { userId: 'u' }), false),
    ).resolves.toBeUndefined();
    expect(deps.acks).not.toHaveBeenCalled();
    expect(deps.sys).toHaveBeenCalledWith(
      'system.loop_errored',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('coffre lanes ⨯ handler — user B is acked while user A is still signing (no head-of-line)', () => {
  it('★ dispatching a batch through per-user lanes lets B reach its terminal ACK behind a stalled A', async () => {
    // WHY (ULTRACODE #22/#31, end-to-end at the loop level): the old serial consume loop processed the batch
    // one message at a time — A's slow sign/confirm delayed B's CLOSE by up to 45s. Through SigningLanes the two
    // users' tasks run concurrently: B is processed and ACKed while A's task has not returned.
    let finishA!: (v: { ok: boolean }) => void;
    const deps = depsOf((payload) =>
      (payload as { userId: string }).userId === 'user-a'
        ? new Promise((r) => {
            finishA = r;
          })
        : Promise.resolve({ ok: true, reason: 'submitted' }),
    );
    const handle = createMessageHandler(deps);
    const lanes = new SigningLanes();
    const msgs = [msgOf('2-0', { userId: 'user-a' }), msgOf('2-1', { userId: 'user-b' })];
    const batch = msgs.map((m) => lanes.dispatch(laneKeyOf(m.payload), () => handle(m, false)));
    await batch[1]; // B completes…
    expect(deps.acks).toHaveBeenCalledTimes(1);
    expect(deps.acks).toHaveBeenCalledWith('s', 'g', '2-1'); // …and it IS B that was acked
    finishA({ ok: true }); // release A (cleanup)
    await Promise.all(batch);
    expect(deps.acks).toHaveBeenCalledTimes(2);
  });
});
