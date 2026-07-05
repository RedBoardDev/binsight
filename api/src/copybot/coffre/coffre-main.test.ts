import { Keypair } from '@solana/web3.js';
import { type Logger, pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { CODE_REGISTRY } from '@/domain/copybot/observability/codes';
import type { ConsumedMessage } from '@/infrastructure/bus/redis-bus';
import {
  createMessageHandler,
  createSignerResolver,
  deadLetterCode,
  type LeaseRenewOutcome,
  type MessageHandlerDeps,
  parseCoffreNumericConfig,
  planLeaseRenew,
  reloadUserConfigs,
  routeVerdict,
  type SignerResolverDeps,
  SigningDisabledError,
  signalsSigningRecovered,
  type UserWallet,
  UserWalletUnresolvedError,
} from './coffre-main';
import { laneKeyOf, SigningLanes } from './lanes';
import type { Signer } from './signer';

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

/** A TOMBSTONE ConsumedMessage: the XTRIM-evicted PEL entry RedisBus.parse surfaces (payload null, empty raw). */
function tombstoneOf(id: string): ConsumedMessage {
  return { id, payload: null, raw: {}, tombstone: true };
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

  it('★ a TOMBSTONE (XTRIM-trimmed PEL entry) is ACKed-and-skipped — never re-processed, never dead-lettered (#147)', async () => {
    // WHY: the trimmed entry's bytes are gone. Feeding it to `process` (payload null) would reject → dead-letter, and
    // deadLetter(raw={}) would throw and re-wedge the loop. The ONLY safe action is ACK-and-skip. Leaving it unACKed
    // (the old TypeError crash) wedged the consume loop on the ghost forever — vault alive (heartbeat green), signing
    // NOTHING, every later close missed.
    const process = vi.fn(async () => ({ ok: true }));
    const deps = depsOf(process);
    await createMessageHandler(deps)(tombstoneOf('9-0'), true);
    expect(process).not.toHaveBeenCalled(); // never decoded — there is nothing to decode
    expect(deps.dlq).not.toHaveBeenCalled(); // never dead-lettered — nothing to preserve (deadLetter({}) would throw)
    expect(deps.acks).toHaveBeenCalledTimes(1);
    expect(deps.acks).toHaveBeenCalledWith('s', 'g', '9-0'); // ACKed → cleared from the PEL, the loop can proceed
  });
});

// Inc.4a — createSignerResolver: resolve + CACHE one Signer per SIGNED tenant. SYSTEM keeps the local-keypair signer
// (bench untouched); a real user routes by PRIVY_SIGNING_ENABLED (live PrivySessionSigner vs DryRunSigner) and every
// failure (not provisioned / signing disabled) is per-user isolated. All deps injected — no Privy, no keypair.
const stubSigner = (): Signer => ({
  publicKey: Keypair.generate().publicKey,
  sign: async () => ({ raw: Buffer.alloc(0), signature: 'stub' }),
});

describe('coffre createSignerResolver — per-user signer routing + caching (Inc.4a)', () => {
  const sys = stubSigner();
  function deps(over: Partial<SignerResolverDeps> = {}): SignerResolverDeps {
    return {
      systemSigner: sys,
      privySigningEnabled: false,
      resolveUserWallet: vi.fn(async () => null),
      buildLiveSigner: vi.fn(() => stubSigner()),
      buildDryRunSigner: vi.fn(() => stubSigner()),
      log: silentLog,
      ...over,
    };
  }
  const walletFor = (signingDisabled = false): UserWallet => ({
    walletId: 'wallet-9',
    address: Keypair.generate().publicKey.toBase58(),
    signingDisabled,
  });

  it('SYSTEM → the cached local-keypair signer, WITHOUT a wallet lookup (bench path untouched)', async () => {
    const resolveUserWallet = vi.fn(async () => null);
    const signerFor = createSignerResolver(deps({ resolveUserWallet }));
    expect(await signerFor(SYSTEM_USER_ID)).toBe(sys);
    expect(resolveUserWallet).not.toHaveBeenCalled(); // SYSTEM never hits the user lookup
  });

  it('caches per user — the SAME instance is returned and resolveUserWallet runs at most once', async () => {
    // WHY: the resolver is called on the hot sign path (once per cmd:sign); a live Privy user must not re-hit the
    // wallet lookup (or rebuild a signer) on every command.
    const wallet = walletFor();
    const resolveUserWallet = vi.fn(async () => wallet);
    const built = stubSigner();
    const signerFor = createSignerResolver(
      deps({ privySigningEnabled: true, resolveUserWallet, buildLiveSigner: () => built }),
    );
    const a = await signerFor('u1');
    const b = await signerFor('u1');
    expect(a).toBe(built);
    expect(b).toBe(a); // cached instance
    expect(resolveUserWallet).toHaveBeenCalledTimes(1);
  });

  it('flag OFF + a resolved wallet → a DryRunSigner over the wallet ADDRESS (pipeline runs, nothing signed)', async () => {
    const wallet = walletFor();
    const buildDryRunSigner = vi.fn(() => stubSigner());
    const signerFor = createSignerResolver(
      deps({
        privySigningEnabled: false,
        resolveUserWallet: async () => wallet,
        buildDryRunSigner,
      }),
    );
    await signerFor('u1');
    expect(buildDryRunSigner).toHaveBeenCalledWith(wallet.address);
  });

  it('flag ON + a resolved, enabled wallet → a live PrivySessionSigner', async () => {
    const wallet = walletFor();
    const buildLiveSigner = vi.fn(() => stubSigner());
    const signerFor = createSignerResolver(
      deps({ privySigningEnabled: true, resolveUserWallet: async () => wallet, buildLiveSigner }),
    );
    await signerFor('u1');
    expect(buildLiveSigner).toHaveBeenCalledWith(wallet);
  });

  it('flag ON + signing_disabled → SigningDisabledError (skip THAT user), never builds a signer', async () => {
    const buildLiveSigner = vi.fn(() => stubSigner());
    const signerFor = createSignerResolver(
      deps({
        privySigningEnabled: true,
        resolveUserWallet: async () => walletFor(true),
        buildLiveSigner,
      }),
    );
    await expect(signerFor('u1')).rejects.toBeInstanceOf(SigningDisabledError);
    expect(buildLiveSigner).not.toHaveBeenCalled();
  });

  it('no activation row (null, the 4a default) → UserWalletUnresolvedError (skip THAT user), whatever the flag', async () => {
    // WHY: in 4a resolveUserWallet ALWAYS returns null — no real user is signable yet. Both flag states must skip that
    // user (no address ⇒ nothing to sign OR dry-run); production therefore only ever serves the SYSTEM signer.
    for (const privySigningEnabled of [false, true]) {
      const signerFor = createSignerResolver(
        deps({ privySigningEnabled, resolveUserWallet: async () => null }),
      );
      await expect(signerFor('u1')).rejects.toBeInstanceOf(UserWalletUnresolvedError);
    }
  });
});

// Inc.4e — signalsSigningRecovered: the ONE signal that flips the coffre's `signingAvailable` flag back true after a
// Privy outage. It must be TRUE only for a real user under live signing — a SYSTEM local-keypair submit or a dry-run
// submit proves nothing about Privy custody, so flipping on one would wrongly clear a genuine "signing unavailable"
// banner while Privy is still down (the observability drift the flip-back gate exists to avoid).
describe('coffre signalsSigningRecovered — only a live-Privy real-user submit clears the outage flag (Inc.4e)', () => {
  it('a real user under PRIVY_SIGNING_ENABLED → recovered (its Privy sign just landed = custody is back)', () => {
    expect(signalsSigningRecovered(true, 'user-9')).toBe(true);
  });

  it('SYSTEM (local keypair) never signals recovery — a bench sign is not proof Privy returned', () => {
    // WHY: the flag is a GLOBAL "is Privy custody working". SYSTEM signs with a LOCAL keypair (it can never raise a
    // Privy outage), so a SYSTEM submit must NOT clear a banner a real user's Privy outage raised — that would HIDE a
    // live outage. Without the SYSTEM guard a bench/SYSTEM broadcast would spuriously flip the flag back true.
    expect(signalsSigningRecovered(true, SYSTEM_USER_ID)).toBe(false);
  });

  it('PRIVY_SIGNING_ENABLED OFF → never signals recovery (dry-run never touches Privy, so nothing to recover)', () => {
    expect(signalsSigningRecovered(false, 'user-9')).toBe(false);
    expect(signalsSigningRecovered(false, SYSTEM_USER_ID)).toBe(false);
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

  it('★ a tombstone in a batch does NOT wedge the loop — the NEXT real command is still processed + ACKed (#147)', async () => {
    // WHY (no-miss): the whole point of the tombstone handling is that ONE ghost PEL entry must not block the
    // following genuine close. A tombstone and a real command dispatch through the loop; both must reach a terminal
    // ACK — the tombstone via skip, the real command via its normal terminal-OK.
    const process = vi.fn(async () => ({ ok: true, reason: 'submitted' }));
    const deps = depsOf(process);
    const handle = createMessageHandler(deps);
    const lanes = new SigningLanes();
    const batch = [tombstoneOf('9-1'), msgOf('9-2', { userId: 'u' })];
    await Promise.all(
      batch.map((m) => lanes.dispatch(laneKeyOf(m.payload), () => handle(m, true))),
    );
    expect(process).toHaveBeenCalledTimes(1); // only the REAL command was decoded (the tombstone was skipped)…
    expect(process).toHaveBeenCalledWith({ userId: 'u' }, true); // …with the real payload, never the tombstone's null
    expect(deps.acks).toHaveBeenCalledTimes(2); // BOTH acked: the tombstone (skip) AND the real command (terminal-OK)
    expect(deps.acks).toHaveBeenCalledWith('s', 'g', '9-1'); // ghost cleared
    expect(deps.acks).toHaveBeenCalledWith('s', 'g', '9-2'); // real close cleared → loop proceeds, no wedge
  });
});

// #138 — reloadUserConfigs isolates each user's config load. reloadConfig runs FIRE-AND-FORGET on a poll timer and a
// control ping, so a rejecting configStore.load (a Postgres blip) would otherwise become an unhandled rejection that
// kills the SOLE signer. The guarantee: keep the last-good config for the failing user, log loudly, never reject.
describe('coffre reloadUserConfigs — a DB blip KEEPS the previous config, never rejects (#138)', () => {
  const capturing = (): { log: Pick<Logger, 'error'>; errs: unknown[] } => {
    const errs: unknown[] = [];
    return {
      errs,
      log: {
        error: (o: unknown) => {
          errs.push(o);
        },
      } as unknown as Pick<Logger, 'error'>,
    };
  };

  it('a throwing load keeps that user PREVIOUS config (same reference) and does NOT reject', async () => {
    // WHY: a stale config is safe (it just misses a live web edit for one poll); a dead coffre strands in-flight
    // closes. So the failing load must be swallowed with the last-good value intact — never propagated.
    const prev = { v: 1 };
    const userConfigs = new Map<string, { v: number }>([[SYSTEM_USER_ID, prev]]);
    const { log, errs } = capturing();
    await expect(
      reloadUserConfigs({
        userConfigs,
        load: async () => {
          throw new Error('db connection blip');
        },
        log,
      }),
    ).resolves.toBeUndefined();
    expect(userConfigs.get(SYSTEM_USER_ID)).toBe(prev); // last-good STANDS — never cleared/overwritten
    expect(errs).toHaveLength(1); // …and the failure was logged LOUDLY (operator visibility)
  });

  it('a healthy load REPLACES the cached config (the normal live-edit path is intact)', async () => {
    const next = { v: 2 };
    const userConfigs = new Map<string, { v: number }>([[SYSTEM_USER_ID, { v: 1 }]]);
    await reloadUserConfigs({ userConfigs, load: async () => next, log: silentLog });
    expect(userConfigs.get(SYSTEM_USER_ID)).toBe(next);
  });

  it('one user failing does NOT block the other users from refreshing (per-user isolation)', async () => {
    const good = { v: 9 };
    const userConfigs = new Map<string, { v: number }>([
      ['A', { v: 1 }],
      ['B', { v: 1 }],
    ]);
    const { log } = capturing();
    await reloadUserConfigs({
      userConfigs,
      load: async (id) => {
        if (id === 'A') throw new Error('blip');
        return good;
      },
      log,
    });
    expect(userConfigs.get('A')).toEqual({ v: 1 }); // A kept its previous
    expect(userConfigs.get('B')).toBe(good); // B still refreshed despite A's failure
  });
});

// #150 — planLeaseRenew is the split-brain guard for the singleton coffre lease. The coffre is the SOLE signer; if a
// second instance ever acquires the (expired) lease, both sign in-flight commands = a DOUBLE-SIGN of real money. The
// guard must fire not only when Redis EXPLICITLY reports the lease lost, but ALSO when a renew merely keeps ERRORING
// (a Redis outage) for longer than the TTL — at that point the lease has provably expired at Redis and can be taken.
describe('coffre planLeaseRenew — split-brain exit on renew errors past the TTL (#150)', () => {
  const TTL = 30_000;
  const LAST = 1_000_000; // the moment of the last SUCCESSFUL renew (the "clock" is anchored here)

  it('a healthy renew (ok=true) → renewed (refresh the last-success clock, keep signing)', () => {
    expect(planLeaseRenew({ ok: true }, LAST + 1, LAST, TTL)).toEqual({ action: 'renewed' });
  });

  it('Redis EXPLICITLY reports the lease gone/taken (ok=false) → exit "lost", as before', () => {
    expect(planLeaseRenew({ ok: false }, LAST + 1, LAST, TTL)).toEqual({
      action: 'exit',
      reason: 'lost',
    });
  });

  it('a TRANSIENT renew error still within the TTL → retry (a brief blip must NOT kill the sole signer)', () => {
    const err: LeaseRenewOutcome = { error: 'ECONNREFUSED' };
    expect(planLeaseRenew(err, LAST + TTL - 1, LAST, TTL)).toEqual({ action: 'retry' });
    expect(planLeaseRenew(err, LAST + TTL, LAST, TTL)).toEqual({ action: 'retry' }); // exactly at TTL: still valid (strict >)
  });

  it('★ a renew that keeps ERRORING PAST the TTL → exit "expired" — NOT the old silent infinite retry (#150)', () => {
    // WHY (the bug): the previous `.catch` only logged "will retry next tick", so a Redis outage longer than the
    // lease TTL silently lost exclusivity forever — a second coffre could then acquire the expired lease and
    // double-sign. Once `now - lastSuccess > TTL`, a renew has NOT succeeded within the TTL, so the lease has
    // provably expired at Redis and this instance MUST exit — regardless of WHY the renews failed.
    expect(planLeaseRenew({ error: 'down' }, LAST + TTL + 1, LAST, TTL)).toEqual({
      action: 'exit',
      reason: 'expired',
    });
  });

  it('★ driving the ttl/2 renew loop through a SUSTAINED outage REACHES exit (bounded, never infinite) (#150)', () => {
    // Model the actual timer: renews fire every ttl/2 and all THROW (Redis down), so lastSuccess never advances.
    // The decision must transition retry → … → exit within a bounded number of ticks (the loop's process.exit(1)),
    // proving the guard terminates instead of retrying forever.
    const renewEveryMs = TTL / 2;
    let lastSuccess = 0;
    let now = 0;
    const actions: string[] = [];
    for (let tick = 0; tick < 100; tick++) {
      now += renewEveryMs;
      const step = planLeaseRenew({ error: 'down' }, now, lastSuccess, TTL);
      actions.push(step.action);
      if (step.action === 'renewed') lastSuccess = now; // never taken here (every renew throws)
      if (step.action === 'exit') break; // the real loop would process.exit(1) at this tick
    }
    expect(actions.at(-1)).toBe('exit'); // it DOES exit — a sustained outage is not retried forever
    expect(actions.filter((a) => a === 'retry').length).toBeGreaterThan(0); // …after tolerating the outage within the TTL
    expect(actions.filter((a) => a === 'retry').length).toBeLessThan(actions.length); // …but only finitely
  });
});

// #151 — parseCoffreNumericConfig fails closed on a bad numeric env. A bare Number() turned a typo like
// MAX_TRADE_SOL=0,5 into NaN, which then made Wall B's BigInt(lamports) THROW for every command (infinite redrive)
// and a NaN SIGN_RETRY_MAX made `attempt <= NaN` false → the sign loop never ran. The vault must instead refuse to
// boot on a bad value, like the SOLANA_HTTP_URL / bus-key guards.
describe('coffre parseCoffreNumericConfig — fail-closed numeric env validation (#151)', () => {
  it('★ a comma-typo MAX_TRADE_SOL=0,5 FAILS CLOSED (never NaN → BigInt(NaN) throw / infinite redrive)', () => {
    expect(parseCoffreNumericConfig({ MAX_TRADE_SOL: '0,5' })).toHaveProperty('error');
    // the dot form is the one the operator meant and MUST still parse (fractional SOL is legal)
    expect(parseCoffreNumericConfig({ MAX_TRADE_SOL: '0.5' })).toMatchObject({ maxTradeSol: 0.5 });
  });

  it('a valid, fully-set env parses to the exact numbers (the boot happy path)', () => {
    expect(
      parseCoffreNumericConfig({
        MAX_TRADE_SOL: '2',
        SIGN_RETRY_MAX: '3',
        SIGN_RETRY_DELAY_MS: '2000',
      }),
    ).toEqual({ maxTradeSol: 2, retryMax: 3, retryDelayMs: 2000 });
  });

  it('an unset env uses the documented defaults (maxTradeSol undefined ⇒ each user DB config wins)', () => {
    expect(parseCoffreNumericConfig({})).toEqual({
      maxTradeSol: undefined,
      retryMax: 2,
      retryDelayMs: 1500,
    });
  });

  it('MAX_TRADE_SOL ≤ 0 / empty / non-finite → error (a 0/negative/NaN ceiling breaks the re-clamp)', () => {
    for (const v of ['0', '-1', 'abc', 'Infinity', '']) {
      expect(parseCoffreNumericConfig({ MAX_TRADE_SOL: v }), v).toHaveProperty('error');
    }
  });

  it('★ a non-integer / NaN SIGN_RETRY_MAX → error (else `attempt <= retryMax` is broken and nothing is signed)', () => {
    for (const v of ['abc', '2,5', '2.5', '-1', 'NaN']) {
      expect(parseCoffreNumericConfig({ SIGN_RETRY_MAX: v }), v).toHaveProperty('error');
    }
    // 0 is valid: exactly one sign+land attempt (no retry).
    expect(parseCoffreNumericConfig({ SIGN_RETRY_MAX: '0' })).toMatchObject({ retryMax: 0 });
  });

  it('a non-integer / NaN SIGN_RETRY_DELAY_MS → error (0 is a valid no-backoff)', () => {
    for (const v of ['abc', '1.5', '1,5', '-1']) {
      expect(parseCoffreNumericConfig({ SIGN_RETRY_DELAY_MS: v }), v).toHaveProperty('error');
    }
    expect(parseCoffreNumericConfig({ SIGN_RETRY_DELAY_MS: '0' })).toMatchObject({
      retryDelayMs: 0,
    });
  });
});
