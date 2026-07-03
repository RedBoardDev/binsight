import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { PGlite } from '@electric-sql/pglite';
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { deriveCommandId } from '@/copybot/command-id';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { executions } from '@/infrastructure/persistence/schema';
import type { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import { type Ctx, process1 } from './process-command';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations applied — exercises the multi-tenant
// executions PK (user_id, command_id) exactly as production creates it.
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();
const log = pino({ level: 'silent' });
const copier = Keypair.generate();
const DLMM = new PublicKey(DLMM_PROGRAM_ID);
const pool = Keypair.generate().publicKey;
const position = Keypair.generate().publicKey;
const USER = 'test-user-1'; // the SIGNED tenant every request carries (SPEC §11)
const usedCommandIds: string[] = []; // uniqueness counter for per-request event keys

/** A close tx that PASSES Wall B: feePayer = owner (copier), a DLMM ix touching the pool + position, no foreign dest. */
function closeTxBase64(): string {
  const t = new Transaction();
  t.feePayer = copier.publicKey;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  t.add(
    new TransactionInstruction({
      programId: DLMM,
      keys: [
        { pubkey: copier.publicKey, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ],
      data: Buffer.alloc(0),
    }),
  );
  return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function closeReq(): Record<string, unknown> {
  const eventKey = `test:${pool.toBase58()}:close:${copier.publicKey.toBase58()}:${usedCommandIds.length}:${process.hrtime.bigint()}`;
  const commandId = deriveCommandId(USER, eventKey);
  usedCommandIds.push(commandId);
  return {
    userId: USER,
    commandId,
    eventKey,
    kind: 'close',
    pool: pool.toBase58(),
    positionPubkey: position.toBase58(),
    owner: copier.publicKey.toBase58(),
    txBase64: closeTxBase64(),
    sizeSol: 0.1,
    targetBinRange: { lower: -1, upper: 1 },
    issuedAtSlot: 100,
    deadlineSlot: 1_000_000,
    issuedAtMs: Date.now(),
  };
}

type Status = { value: { err?: unknown; confirmationStatus?: string } | null };
function fakeConn(status: () => Status): Connection {
  return {
    getSlot: async () => 200,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1_000,
    }),
    getBlockHeight: async () => 500,
    sendRawTransaction: async () => `SIG_${Math.floor(Math.random() * 1e9)}`,
    getSignatureStatus: async () => status(),
  } as unknown as Connection;
}
const blockhashCache = {
  get: () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
} as unknown as BlockhashCache;
// Typed observability emitter (P2): process1 emits codes through `events.emit`. A no-op fake here keeps the test
// focused on the verdict + the executions idempotency state (the observability rows are covered by their own suites).
const events = { emit: () => {} } as unknown as CopyEvents;

function ctxFor(conn: Connection, bus: RedisBus): Ctx {
  return {
    conn,
    db,
    bus,
    copier,
    blockhashCache,
    events,
    // Per-user sign-time policy (SPEC §11): the default fixture serves ONE flat cap for any user; the dedicated
    // per-user tests below override it to prove the coffre reads the REQUEST's user row.
    policyFor: async () => ({ maxTradeSol: 1.0 }),
    signingEnabled: true,
    hmacKey: 'k',
    retryMax: 0,
    retryDelayMs: 0,
    onSubmitted: vi.fn(), // lane → confirm-worker hand-off (3c); a fresh spy per ctx so tests can assert it
    log,
  };
}

describe('process1 — 3c: the lane ends at the BROADCAST (a returned signature is NOT execution)', () => {
  it('a successful broadcast → verdict "submitted", row state=submitted, hand-off to the worker — NO ev:executed yet', async () => {
    // WHY (ULTRACODE #22/#31 + the no-dormant-position rule): the lane must free at the broadcast — an in-lane
    // confirm wait would head-of-line-block other users — and a signature alone is NOT execution: publishing
    // ev:executed here would let the brain markClosed a tx that may still drop. Only the confirm worker, on an
    // on-chain confirmation, may finalize 'landed' + publish (see confirm-worker.test.ts).
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = closeReq();
    const ctx = ctxFor(conn, bus);
    const verdict = await process1(sr, ctx);
    expect(verdict).toEqual({ ok: true, reason: 'submitted', kind: 'close' });
    expect(bus.publish).not.toHaveBeenCalled(); // ev:executed belongs to the worker, on confirmation ONLY
    const row = (
      await db
        .select()
        .from(executions)
        .where(eq(executions.commandId, sr.commandId as string))
    )[0];
    expect(row?.state).toBe('submitted');
    // The hand-off carries the exact broadcast + the publish context — and the SAME context is durable on the row,
    // so a worker restarted after a crash can still publish a faithful ev:executed.
    expect(ctx.onSubmitted).toHaveBeenCalledTimes(1);
    const tracked = vi.mocked(ctx.onSubmitted).mock.calls[0]?.[0];
    expect(tracked).toMatchObject({
      userId: USER,
      commandId: sr.commandId,
      lastValidBlockHeight: 1_000,
      publish: {
        kind: 'close',
        pool: pool.toBase58(),
        positionPubkey: position.toBase58(),
        owner: copier.publicKey.toBase58(),
        sizeSol: 0.1,
      },
    });
    expect(tracked?.signature).toBeTruthy();
    expect(row?.publishCtx).toEqual(tracked?.publish);
  });

  it('an in-flight (submitted) command is a DUPLICATE on replay — no double-broadcast while the worker confirms', async () => {
    // WHY: between the broadcast and the worker's confirmation the command is neither landed nor failed; a
    // re-delivered copy must NOT re-sign (a 2nd broadcast of an add/buy/sell has no on-chain idempotency).
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'finalized' } }));
    const sr = closeReq();
    const ctx = ctxFor(conn, bus);
    expect((await process1(sr, ctx)).ok).toBe(true);
    const again = await process1(sr, ctx); // same commandId, now 'submitted' → not re-claimable in normal flow
    expect(again).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(ctx.onSubmitted).toHaveBeenCalledTimes(1); // one broadcast, one hand-off
  });

  it('dry-run (signing disabled) short-circuits to skipped (nothing broadcast, nothing handed to the worker)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { err: 'should-not-be-checked' } }));
    const sr = closeReq();
    const ctx = { ...ctxFor(conn, bus), signingEnabled: false };
    const verdict = await process1(sr, ctx);
    expect(verdict).toMatchObject({ ok: true, reason: 'dry-run' });
    expect(bus.publish).not.toHaveBeenCalled();
    expect(ctx.onSubmitted).not.toHaveBeenCalled();
  });
});

describe('process1 — multi-tenant identity (SPEC §11: the SIGNED userId drives derivation + policy)', () => {
  it('a request WITHOUT a userId is rejected bad_schema (the tenant is a required bus-contract field)', async () => {
    // WHY: without a mandatory tenant the coffre would have to fall back to a hardcoded user — the exact
    // ambiguity the v2 contract removes.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const { userId, ...withoutUser } = closeReq();
    const verdict = await process1(withoutUser, ctxFor(conn, bus));
    expect(verdict).toMatchObject({ ok: false, reason: 'bad_schema' });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('★ a CROSS-TENANT replay (user B re-sends user A commandId) is rejected commandId_mismatch, never signed', async () => {
    // WHY (check #7 v2): the coffre re-derives commandId from the SIGNED (userId, eventKey). Re-labelling user
    // A's command with user B's identity would bind B's config/idempotency slot to A's tx — the re-derivation
    // makes that impossible: derive(B, eventKey) ≠ derive(A, eventKey) = sr.commandId.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = closeReq(); // commandId = derive(USER, eventKey)
    const verdict = await process1({ ...sr, userId: 'other-user' }, ctxFor(conn, bus));
    expect(verdict).toMatchObject({ ok: false, reason: 'commandId_mismatch' });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it("★ the re-clamp uses the REQUEST user's own cap — user B small cap rejects what user A cap allows", async () => {
    // WHY: the coffre must select the caps/config row of the SIGNED userId (per-user config store), not a
    // hardcoded SYSTEM row — else every tenant would trade under one user's ceiling.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const caps: Record<string, number> = { [USER]: 1.0, 'small-user': 0.05 };
    const perUserCtx: Ctx = {
      ...ctxFor(conn, bus),
      policyFor: async (userId) => ({ maxTradeSol: caps[userId] ?? 0 }),
    };
    // user A (cap 1.0): a 0.1 SOL close passes the re-clamp and broadcasts.
    expect((await process1(closeReq(), perUserCtx)).ok).toBe(true);
    // user B (cap 0.05): the SAME 0.1 SOL size is over ITS cap → rejected before any signature.
    const eventKey = `test:${pool.toBase58()}:close:small:${process.hrtime.bigint()}`;
    const smallUserReq = {
      ...closeReq(),
      userId: 'small-user',
      eventKey,
      commandId: deriveCommandId('small-user', eventKey),
    };
    const verdict = await process1(smallUserReq, perUserCtx);
    expect(verdict).toMatchObject({ ok: false, reason: 'over_max_trade' });
  });

  it('★ the SAME eventKey copied for TWO users signs TWICE (independent idempotency slots — ULTRACODE #25/#27)', async () => {
    // WHY (the user-#2-duplicate-rejection bug class): pre-v2, both users' commands for one leader event shared
    // one commandId → the second was rejected 'duplicate' and that user silently missed the copy. With
    // derive(userId, eventKey) + the (user_id, command_id) claim, both broadcast.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sharedEventKey = `test:${pool.toBase58()}:close:shared:${process.hrtime.bigint()}`;
    const forUser = (userId: string): Record<string, unknown> => ({
      ...closeReq(),
      userId,
      eventKey: sharedEventKey,
      commandId: deriveCommandId(userId, sharedEventKey),
    });
    expect((await process1(forUser('user-a'), ctxFor(conn, bus))).ok).toBe(true);
    const second = await process1(forUser('user-b'), ctxFor(conn, bus));
    expect(second).toEqual({ ok: true, reason: 'submitted', kind: 'close' }); // NOT { ok:false, reason:'duplicate' }
    // …while the same user replaying the same event stays a duplicate (idempotency intact):
    expect(await process1(forUser('user-a'), ctxFor(conn, bus))).toMatchObject({
      ok: false,
      reason: 'duplicate',
    });
  });
});

describe('process1 — #3: a successful broadcast is TERMINAL for the lane (nothing after it can re-sign/re-land)', () => {
  it('a hand-off after the broadcast never re-enters the retry scope (one land, retryMax=1)', async () => {
    // WHY (the money-path bug class): once the tx is on the wire the on-chain action may apply and is then
    // IRREVERSIBLE. If anything after the broadcast (hand-off, logging) threw INSIDE the retry scope, the loop
    // would re-sign the SAME tx with a fresh blockhash and RE-LAND it — a real-money double add/buy/sell/remove
    // (no on-chain idempotency). The hand-off runs OUTSIDE the try: land is called exactly once.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => `SIG_${Math.floor(Math.random() * 1e9)}`); // one land == one sendRawTransaction
    const conn = {
      getSlot: async () => 200,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
      sendRawTransaction: land,
    } as unknown as Connection;
    const sr = closeReq();
    const verdict = await process1(sr, { ...ctxFor(conn, bus), retryMax: 1 });
    expect(land).toHaveBeenCalledTimes(1); // no double-land
    expect(verdict).toEqual({ ok: true, reason: 'submitted', kind: 'close' });
  });

  // NOTE: the post-CONFIRM terminal guarantee (a publish failure after a confirmed land never re-lands) now lives
  // with its owner: confirm-worker.test.ts ("a publish failure after a confirmed land stays landed").
});

// --- OPEN with a WSOL wrap: exercises the position-signer path + the #3 Wall-B SOL-spend cap, END-TO-END in process1.
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const ownerWsolAta = (owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), WSOL.toBuffer()],
    ATA_PROGRAM,
  )[0];

/** A valid OPEN that WRAPS `wrapLamports` SOL into the copier's WSOL ATA (the real capital deployed). The ephemeral
 *  position (derived from commandId, as the coffre will) is a required signer so Wall B's open check passes. */
function openReq(wrapLamports: number, sizeSol = 0.1): Record<string, unknown> {
  const eventKey = `test:${pool.toBase58()}:open:${copier.publicKey.toBase58()}:${usedCommandIds.length}:${process.hrtime.bigint()}`;
  const commandId = deriveCommandId(USER, eventKey);
  usedCommandIds.push(commandId);
  const ephemeral = derivePositionKeypair(commandId).publicKey;
  const t = new Transaction();
  t.feePayer = copier.publicKey;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  t.add(
    new TransactionInstruction({
      programId: DLMM,
      keys: [
        { pubkey: copier.publicKey, isSigner: true, isWritable: true },
        { pubkey: ephemeral, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ],
      data: Buffer.alloc(0),
    }),
    SystemProgram.transfer({
      fromPubkey: copier.publicKey,
      toPubkey: ownerWsolAta(copier.publicKey),
      lamports: wrapLamports,
    }),
  );
  return {
    userId: USER,
    commandId,
    eventKey,
    kind: 'open',
    pool: pool.toBase58(),
    positionPubkey: ephemeral.toBase58(),
    owner: copier.publicKey.toBase58(),
    txBase64: t
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    sizeSol,
    targetBinRange: { lower: -1, upper: 1 },
    issuedAtSlot: 100,
    deadlineSlot: 1_000_000,
    issuedAtMs: Date.now(),
  };
}

describe('process1 — OPEN: position-signer + the #3 Wall-B SOL-spend cap end-to-end', () => {
  it('an open whose wrap is UNDER the cap (sized at maxTradeSol) broadcasts', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = openReq(900_000_000, 0.9); // wrap 0.9 SOL ≤ cap (maxTradeSol 1.0 × 1.1 + 0.005)
    const ctx = ctxFor(conn, bus);
    const verdict = await process1(sr, ctx);
    expect(verdict).toEqual({ ok: true, reason: 'submitted', kind: 'open' });
    expect(ctx.onSubmitted).toHaveBeenCalledTimes(1); // handed to the confirm worker
  });

  it('an open that UNDER-REPORTS sizeSol but WRAPS far more than the cap → rejected wallb:sol_spend_over_cap (no sign)', async () => {
    // WHY: the #3 fix — the re-clamp only bounds the self-reported sizeSol (0.1, under maxTradeSol so it passes the
    // size check); Wall B must catch that the tx actually wraps 5 SOL, far over the cap, and refuse to sign.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = openReq(5_000_000_000, 0.1); // reports 0.1 SOL but wraps 5 SOL
    const ctx = ctxFor(conn, bus);
    const verdict = await process1(sr, ctx);
    expect(verdict).toMatchObject({ ok: false, reason: 'wallb:sol_spend_over_cap', kind: 'open' });
    expect(ctx.onSubmitted).not.toHaveBeenCalled(); // never signed/broadcast
    const row = await db
      .select()
      .from(executions)
      .where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('failed');
  });
});

// --- BUY (Jupiter SOL→token, funds a two-sided open): validates the #4 fix — a buy that doesn't confirm must NOT
// publish ev:executed (else the dependent two-sided open builds tokenless and fails).
const JUP = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
function buyReq(outputMint: PublicKey): Record<string, unknown> {
  const eventKey = `test:${pool.toBase58()}:buy:${copier.publicKey.toBase58()}:${usedCommandIds.length}:${process.hrtime.bigint()}`;
  const commandId = deriveCommandId(USER, eventKey);
  usedCommandIds.push(commandId);
  const t = new Transaction();
  t.feePayer = copier.publicKey;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  t.add(
    new TransactionInstruction({
      programId: JUP,
      keys: [
        { pubkey: copier.publicKey, isSigner: true, isWritable: true },
        {
          pubkey: PublicKey.findProgramAddressSync(
            [copier.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), outputMint.toBuffer()],
            ATA_PROGRAM,
          )[0],
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.alloc(0),
    }),
  );
  return {
    userId: USER,
    commandId,
    eventKey,
    kind: 'buy',
    pool: pool.toBase58(),
    positionPubkey: copier.publicKey.toBase58(),
    owner: copier.publicKey.toBase58(),
    txBase64: t
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    sizeSol: 0.1,
    targetBinRange: { lower: 0, upper: 0 },
    issuedAtSlot: 100,
    deadlineSlot: 1_000_000,
    issuedAtMs: Date.now(),
    buy: {
      outputMint: outputMint.toBase58(),
      exactOutAmountRaw: '1000',
      maxInLamports: '100000000',
    },
  };
}

describe('process1 — BUY confirm gate (#4: ev:executed for a buy comes ONLY from the confirm worker)', () => {
  it('a buy broadcast publishes NOTHING from the lane — the dependent two-sided open must wait for the confirmation', async () => {
    // WHY (#4): the brain builds the dependent open only on the buy's ev:executed. If the lane published at
    // broadcast time, an unconfirmed/dropped buy would trigger a TOKENLESS two-sided open downstream. The worker
    // publishes only on an on-chain confirmation (confirm-worker.test.ts covers the confirm/expiry outcomes).
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const ctx = ctxFor(conn, bus);
    const verdict = await process1(buyReq(Keypair.generate().publicKey), ctx);
    expect(verdict).toEqual({ ok: true, reason: 'submitted', kind: 'buy' });
    expect(bus.publish).not.toHaveBeenCalled(); // no premature ev:executed for a mere broadcast
    expect(vi.mocked(ctx.onSubmitted).mock.calls[0]?.[0]?.publish).toMatchObject({ kind: 'buy' });
  });
});

// --- #7 EXACTLY-ONCE money-path: persist the signature + blockhash expiry BEFORE broadcast, then on recovery only
// re-sign a PROVABLY-dead tx. Without this, a vault crash after land() but before finalize('landed') re-signs on boot
// → the first tx AND the recovery tx both confirm → a real-money DOUBLE add/buy/sell/remove (no on-chain idempotency).
const PRIOR_SIG = 'PriorBroadcastSignature111111111111111111111';
const LVBH = 1_000; // lastValidBlockHeight stored with the submitted tx

/** Seed an already-broadcast executions row (state 'submitted' with a signature+expiry) as a crashed prior attempt. */
async function seedSubmitted(
  sr: Record<string, unknown>,
  signature: string | null,
  lastValidBlockHeight: number,
): Promise<void> {
  await db.insert(executions).values({
    userId: sr.userId as string,
    commandId: sr.commandId as string,
    eventKey: sr.eventKey as string,
    state: signature ? 'submitted' : 'claimed',
    deadlineSlot: 1_000_000,
    signature,
    lastValidBlockHeight,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** A conn whose getSignatureStatus/getBlockHeight are stubbed to drive the recovery pre-check outcome. */
function recoveryConn(opts: {
  priorStatus: Status;
  blockHeight: number;
  land: (raw: unknown) => Promise<string>;
}): Connection {
  return {
    getSlot: async () => 200,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: LVBH,
    }),
    getBlockHeight: async () => opts.blockHeight,
    // The seeded PRIOR_SIG is classified per opts.priorStatus; any OTHER (freshly re-signed) sig confirms so a
    // legitimately-dead retry can complete.
    getSignatureStatus: async (s: string) =>
      s === PRIOR_SIG
        ? opts.priorStatus
        : ({ value: { confirmationStatus: 'confirmed' } } as Status),
    sendRawTransaction: opts.land,
  } as unknown as Connection;
}

describe('process1 — #7: markSubmitted persists sig+expiry BEFORE the tx hits the wire', () => {
  it('the executions row is already "submitted" with signature+lastValidBlockHeight when land() is called', async () => {
    // WHY (the money-path bug): the crash-recoverable state (signature + blockhash expiry) MUST exist on-chain-side
    // BEFORE the tx is broadcast — otherwise a crash between land() and finalize() leaves recovery blind and it
    // re-broadcasts. We observe the DB row at the exact moment sendRawTransaction fires.
    const sr = closeReq();
    let stateAtLand: string | undefined;
    let sigAtLand: string | null | undefined;
    let lvbhAtLand: number | null | undefined;
    let publishCtxAtLand: unknown;
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = {
      getSlot: async () => 200,
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: LVBH,
      }),
      getBlockHeight: async () => 500,
      getSignatureStatus: async () => ({ value: { confirmationStatus: 'confirmed' } }),
      sendRawTransaction: async () => {
        const row = (
          await db
            .select()
            .from(executions)
            .where(eq(executions.commandId, sr.commandId as string))
        )[0];
        stateAtLand = row?.state;
        sigAtLand = row?.signature;
        lvbhAtLand = row?.lastValidBlockHeight;
        publishCtxAtLand = row?.publishCtx;
        return `SIG_${Math.floor(Math.random() * 1e9)}`;
      },
    } as unknown as Connection;
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict.ok).toBe(true);
    expect(stateAtLand).toBe('submitted'); // markSubmitted ran BEFORE land
    expect(sigAtLand).toBeTruthy();
    expect(lvbhAtLand).toBe(LVBH);
    // 3c: the worker's publish context is durable BEFORE the wire too — a crash right after land still leaves a
    // row the restarted worker can both finalize AND publish from.
    expect(publishCtxAtLand).toMatchObject({ kind: 'close', pool: pool.toBase58() });
  });
});

describe('process1 — #7: recovery pre-check re-signs ONLY a provably-dead tx (exactly-once)', () => {
  it('case 1 (LANDED): a submitted row whose sig is confirmed → finalize landed + publish, NEVER re-signs', async () => {
    // WHY: this is the double-execution guard. The prior tx already confirmed (money moved). Boot recovery MUST NOT
    // re-broadcast. Against the pre-#7 code (recovering re-claims a stranded row and re-signs) `land` is called → a
    // double add/buy. With the fix the on-chain check sees 'confirmed' and finalizes without signing.
    const sr = closeReq();
    await seedSubmitted(sr, PRIOR_SIG, LVBH);
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => 'SHOULD_NOT_BE_CALLED');
    const conn = recoveryConn({
      priorStatus: { value: { confirmationStatus: 'confirmed' } },
      blockHeight: 500,
      land,
    });
    const verdict = await process1(sr, ctxFor(conn, bus), true); // recovering
    expect(land).not.toHaveBeenCalled(); // ← FAILS on the pre-#7 code (it re-signs the landed tx)
    expect(verdict).toEqual({ ok: true, kind: 'close' });
    expect(bus.publish).toHaveBeenCalledTimes(1); // ev:executed re-published (idempotent downstream)
    // The recovery RE-publish carries the tenant too (3b fan-out): a confirm replayed after a coffre restart must
    // still route to the owning user's runtime, exactly like a fresh land.
    expect(vi.mocked(bus.publish).mock.calls[0]?.[3]).toMatchObject({
      commandId: sr.commandId,
      sig: PRIOR_SIG,
      userId: USER,
    });
    const row = await db
      .select()
      .from(executions)
      .where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('landed');
  });

  it('case 2 (DEAD): sig not found + blockhash expired (getBlockHeight > lastValidBlockHeight) → re-signs exactly once', async () => {
    // WHY: a tx whose blockhash has expired and that the chain has never seen is provably dead — the copy would be
    // MISSED if we did not re-drive it. The recovery re-signs and broadcasts EXACTLY one new tx, whose row carries
    // a FRESH signature (the stale one is cleared by the re-claim — the worker's signature-pinned finalize relies
    // on it) and goes back to the worker as a normal 'submitted'.
    const sr = closeReq();
    await seedSubmitted(sr, PRIOR_SIG, LVBH);
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => `SIG_${Math.floor(Math.random() * 1e9)}`);
    const conn = recoveryConn({ priorStatus: { value: null }, blockHeight: LVBH + 1_000, land }); // not found + expired
    const ctx = ctxFor(conn, bus);
    const verdict = await process1(sr, ctx, true);
    expect(land).toHaveBeenCalledTimes(1); // one — and only one — new land
    expect(verdict).toEqual({ ok: true, reason: 'submitted', kind: 'close' });
    const row = await db
      .select()
      .from(executions)
      .where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('submitted');
    expect(row[0]?.signature).not.toBe(PRIOR_SIG); // the dead broadcast's sig is gone — a fresh attempt owns the row
    expect(ctx.onSubmitted).toHaveBeenCalledTimes(1); // …and the worker now watches the NEW signature
  });

  it('case 3 (IN-FLIGHT): sig not found but blockhash still valid → does NOT re-sign this pass (retryLater, unACKed)', async () => {
    // WHY: the tx may still land under a live blockhash. Re-signing now risks a double execution; ACKing now would
    // strand it. We leave it for a later recovery pass (retryLater → the loop does not ACK).
    const sr = closeReq();
    await seedSubmitted(sr, PRIOR_SIG, LVBH);
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => 'SHOULD_NOT_BE_CALLED');
    const conn = recoveryConn({ priorStatus: { value: null }, blockHeight: LVBH - 100, land }); // not found + still valid
    const verdict = await process1(sr, ctxFor(conn, bus), true);
    expect(land).not.toHaveBeenCalled(); // no re-sign while the blockhash lives
    expect(verdict).toMatchObject({ ok: false, reason: 'recover_in_flight', retryLater: true });
    expect(bus.publish).not.toHaveBeenCalled();
    const row = await db
      .select()
      .from(executions)
      .where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('submitted'); // untouched — awaits a later pass
  });

  it("a 'claimed' row with NO signature (crashed BEFORE broadcast) → nothing landed → re-signs safely", async () => {
    // WHY: markSubmitted had not run, so no tx ever hit the wire. Re-signing cannot double-execute.
    const sr = closeReq();
    await seedSubmitted(sr, null, 0); // signature null → state 'claimed'
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => `SIG_${Math.floor(Math.random() * 1e9)}`);
    const conn = recoveryConn({ priorStatus: { value: null }, blockHeight: 500, land });
    const verdict = await process1(sr, ctxFor(conn, bus), true);
    expect(land).toHaveBeenCalledTimes(1); // safe re-sign (nothing was broadcast)
    expect(verdict).toEqual({ ok: true, reason: 'submitted', kind: 'close' });
  });
});
