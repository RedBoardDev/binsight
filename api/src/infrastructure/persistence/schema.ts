import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// epoch-millisecond timestamp (Date.now()); fits a JS number, stored as bigint.
const ms = (name: string) => bigint(name, { mode: 'number' });

export const positions = pgTable(
  'positions',
  {
    positionAddress: text('position_address').primaryKey(),
    wallet: text('wallet').notNull(),
    poolAddress: text('pool_address').notNull(),
    tokenX: text('token_x'),
    tokenY: text('token_y'),
    tokenXMint: text('token_x_mint'),
    tokenXIcon: text('token_x_icon'),
    tokenYIcon: text('token_y_icon'),
    status: text('status').notNull(), // 'open' | 'pending_close' | 'closed'
    // Strategy family (Spot/Curve/BidAsk) decoded once from the on-chain open tx; immutable.
    strategy: text('strategy'),
    pnlSol: doublePrecision('pnl_sol'),
    pnlPctSol: doublePrecision('pnl_pct_sol'),
    sizeSol: doublePrecision('size_sol'),
    depositSol: doublePrecision('deposit_sol'),
    withdrawSol: doublePrecision('withdraw_sol'),
    claimedFeesSol: doublePrecision('claimed_fees_sol'),
    unclaimedFeesSol: doublePrecision('unclaimed_fees_sol'),
    // Residual revalued at the live market (Jupiter) price at close; kept separate from pnl_sol so
    // the periodic pool-price resync never overwrites the market reprice.
    marketPnlSol: doublePrecision('market_pnl_sol'),
    minPrice: doublePrecision('min_price'),
    maxPrice: doublePrecision('max_price'),
    poolPrice: doublePrecision('pool_price'),
    rangeStatus: text('range_status'),
    oorSince: ms('oor_since'),
    openedAt: ms('opened_at'),
    closedAt: ms('closed_at'),
    durationSeconds: integer('duration_seconds'),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [
    index('idx_positions_wallet_status').on(t.wallet, t.status),
    index('idx_positions_wallet_closed_at').on(t.wallet, t.closedAt),
    // Serves the 'all'/stats scope (status='closed' ORDER BY closed_at) without a leading wallet.
    index('idx_positions_status_closed_at').on(t.status, t.closedAt),
    // Covers statsAggregate's exact filter (wallet IN … AND status='closed' AND closed_at >= since) so
    // it's an index range, not a heap recheck on a partial-match index.
    index('idx_positions_wallet_status_closed_at').on(t.wallet, t.status, t.closedAt),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Copy-bot · per-user runtime config (SPEC §12): one row per user, replacing the single
// settings['copybot.config'] blob. `config` holds the whole CopybotConfig JSON blob — ONE row write = an atomic
// config swap (no half-applied multi-row update). Parsing fails CLOSED on a corrupt blob (see domain/copybot/config).
export const copybotConfigs = pgTable('copybot_configs', {
  userId: text('user_id').primaryKey(),
  config: text('config').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

// --- Decoupled on-chain DLMM engine: raw liquidity legs decoded from chain (no Meteora API). ---
// Each row is one deposit/withdraw/claim movement decoded from a DLMM Anchor event, with the active
// bin at that tx (the historical price anchor). Per-position PnL is computed from these, all-history.
export const dlmmLegs = pgTable(
  'dlmm_legs',
  {
    id: serial('id').primaryKey(),
    signature: text('signature').notNull(),
    wallet: text('wallet').notNull(),
    position: text('position').notNull(),
    lbPair: text('lb_pair').notNull(),
    kind: text('kind').notNull(), // 'deposit' | 'withdraw' | 'claim' | 'close' (zero-amount close marker)
    activeBinId: integer('active_bin_id').notNull(),
    // raw u64 token lamports as decimal strings (can exceed JS/​int64 safe range for big memecoins).
    amountX: text('amount_x').notNull(),
    amountY: text('amount_y').notNull(),
    blockTime: bigint('block_time', { mode: 'number' }), // unix seconds (tx.blockTime)
  },
  (t) => [
    index('idx_dlmm_legs_wallet').on(t.wallet),
    index('idx_dlmm_legs_position').on(t.position),
    index('idx_dlmm_legs_signature').on(t.signature),
  ],
);

// Copy-bot — audit log of detected LEADER DLMM actions (one row per leader tx). Unique on `signature` =
// idempotent: the live WS and the completeness poll both surface the same tx, but only one row is ever
// written (onConflictDoNothing), and a re-run never double-counts. This is the P1 audit trail; the copy
// decision/execution columns come in later phases.
export const leaderActivity = pgTable(
  'leader_activity',
  {
    id: serial('id').primaryKey(),
    signature: text('signature').notNull(),
    leader: text('leader').notNull(), // the followed leader wallet
    instruction: text('instruction').notNull(), // raw DLMM instruction name (headline)
    action: text('action'), // classified: open | close | add | remove | claim (null if unclassified)
    depositSol: doublePrecision('deposit_sol').notNull().default(0), // capital in (open/add)
    withdrawSol: doublePrecision('withdraw_sol').notNull().default(0), // capital out (close/remove)
    claimSol: doublePrecision('claim_sol').notNull().default(0), // fees claimed
    pool: text('pool'), // lbPair
    nonSolMint: text('non_sol_mint'),
    nonSolSymbol: text('non_sol_symbol'),
    blockTime: bigint('block_time', { mode: 'number' }), // unix seconds (tx.blockTime)
    source: text('source').notNull(), // replay | ws | poll
    detectedAt: ms('detected_at').notNull(), // when WE recorded it (Date.now)
  },
  (t) => [
    uniqueIndex('uq_leader_activity_signature').on(t.signature),
    index('idx_leader_activity_leader').on(t.leader),
  ],
);

// Copy-bot · P2 paper shadow-log: what we WOULD have done for each leader entry (no signature, no
// funds). Dedicated paper table, deliberately minimal — no multi-tenant fields until users
// (J2-web) exist; will converge toward `copies`/`activity_log` (spec 11 §2.3-2.4) at that point.
export const copyDecisions = pgTable(
  'copy_decisions',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(), // tenant FK → users.id; single-user runtime binds SYSTEM_USER_ID at boot
    signature: text('signature').notNull(), // leader tx that triggered the decision
    leader: text('leader').notNull(),
    pool: text('pool'),
    position: text('position'), // DLMM position pubkey
    eventKind: text('event_kind').notNull(), // 'open' (entry) — extended later (add/close/claim)
    outcome: text('outcome').notNull(), // mirrored | reduced | skipped
    skipReason: text('skip_reason'), // non_sol_paired | below_min_floor | insufficient_balance (if skipped)
    leaderSizeSol: doublePrecision('leader_size_sol').notNull().default(0), // leader open size
    ourSizeSol: doublePrecision('our_size_sol'), // size we would have opened (null if skipped)
    blockTime: bigint('block_time', { mode: 'number' }), // unix seconds (tx.blockTime)
    decidedAt: ms('decided_at').notNull(), // when WE decided (Date.now)
  },
  (t) => [
    // Per-user idempotence (SPEC §11): two users deciding on the SAME leader tx are two rows — a signature-only
    // unique would reject user #2's decision as user #1's duplicate.
    uniqueIndex('uq_copy_decisions_user_signature').on(t.userId, t.signature),
    index('idx_copy_decisions_leader').on(t.leader),
  ],
);

// Copy-bot · coffre — execution idempotency registry. The coffre claims `(user_id, command_id)` via INSERT ON
// CONFLICT DO NOTHING BEFORE signing → a replay (crash/redelivery) never double-signs (spec 10 §3.3).
// PK includes user_id (SPEC §11): the same leader event copied for two users is TWO independent commands —
// keying by command_id alone would reject user #2's copy as user #1's duplicate (ULTRACODE #25/#27).
export const executions = pgTable(
  'executions',
  {
    userId: text('user_id').notNull(), // tenant FK → users.id; single-user runtime binds SYSTEM_USER_ID at boot
    commandId: text('command_id').notNull(),
    eventKey: text('event_key').notNull(),
    state: text('state').notNull(), // claimed | submitted | landed | failed | skipped
    deadlineSlot: bigint('deadline_slot', { mode: 'number' }),
    // Exactly-once money path (#7): persisted BEFORE broadcast so boot recovery can check the chain and only
    // re-sign a PROVABLY-dead tx. `signature` = the broadcast tx sig; `lastValidBlockHeight` = its blockhash expiry.
    signature: text('signature'),
    lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }),
    // Async confirm (3c): the ev:executed/observability context (kind/pool/position/owner/size/issuedAt) persisted
    // WITH the broadcast, so the confirm worker can finalize AND publish a 'submitted' row after a restart — the
    // cmd:sign message may already be ACKed by then (the row, not the PEL, is the durable state past broadcast).
    publishCtx: jsonb('publish_ctx'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.commandId] })],
);

// Copy-bot · brain — positions we COPY (PERSISTENT source of truth, survives restarts). Without it
// the in-memory registry would be lost on restart → DORMANT positions (open on our side while the leader
// has closed). The failsafe reconciles these rows (status='open') against the leader's on-chain state.
// PK includes user_id (SPEC §11): two users mirroring the SAME leader position are two independent mirrors —
// a leader_position-only PK would silently drop user #2's row (onConflictDoNothing) = a lost mirror.
export const copyPositions = pgTable(
  'copy_positions',
  {
    userId: text('user_id').notNull(), // tenant FK → users.id; single-user runtime binds SYSTEM_USER_ID at boot
    leaderPosition: text('leader_position').notNull(),
    // Wallet address of the LEADER this mirror copies (3b: per-leader stop-closes/exposure/rug config).
    // Nullable: legacy pre-3b rows have no leader — the loader falls back to '' which planStopCloses
    // treats as stopped (only a global stop force-closes such a row).
    leader: text('leader'),
    ourPosition: text('our_position').notNull(),
    pool: text('pool').notNull(),
    nonSolSymbol: text('non_sol_symbol'),
    sizeSol: doublePrecision('size_sol').notNull(),
    lowerBin: integer('lower_bin').notNull(),
    upperBin: integer('upper_bin').notNull(),
    status: text('status').notNull(), // open | closed
    openedAt: ms('opened_at').notNull(),
    closedAt: ms('closed_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.leaderPosition] })],
);

// Copy-bot · brain — LEADER positions we rug-SL-exited, ONE ROW PER EXIT (SPEC §12: replaces the settings-KV
// JSON blob, which failed OPEN — a corrupt blob loaded as an EMPTY set, silently dropping the re-open
// suppression). Row-level inserts are atomic and corruption-proof; bounded by the number of distinct rug exits
// (a NEW leader open uses a new pubkey, never matched).
export const rugExits = pgTable(
  'rug_exits',
  {
    userId: text('user_id').notNull(), // tenant FK → users.id; single-user runtime binds SYSTEM_USER_ID at boot
    leaderPosition: text('leader_position').notNull(), // the LEADER position we exited → suppress RE-OPEN
    exitedAt: ms('exited_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.leaderPosition] })],
);

// Copy-bot · brain — OUR positions rug-SL/stop-closed but NOT yet confirmed gone on-chain: the reconcile
// re-closes them until the close is confirmed (never-miss-close), then the row is DELETED (close-confirm or
// reconcile purge). Separate from rug_exits: a STOP close must retry-until-gone WITHOUT permanently
// suppressing the leader position (a stop→start cycle may legitimately re-mirror it).
export const rugExitPendings = pgTable(
  'rug_exit_pending',
  {
    userId: text('user_id').notNull(), // tenant FK → users.id; single-user runtime binds SYSTEM_USER_ID at boot
    ourPosition: text('our_position').notNull(), // OUR mirror position whose close must be confirmed gone
    createdAt: ms('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ourPosition] })],
);

// Copy-bot activity journal — append-only, lifecycle-wide record of every meaningful action across BOTH processes
// (brain + coffre). Source of truth for the web activity feed. Taxonomy is compositional: (stage, outcome[, reason]).
// See domain/copybot/journal.ts for the closed enums; `reason` stores the producer's functional code verbatim.
export const copyJournal = pgTable(
  'copy_journal',
  {
    id: serial('id').primaryKey(),
    ts: ms('ts').notNull(), // when WE recorded it (Date.now)
    process: text('process').notNull(), // brain | coffre
    stage: text('stage').notNull(), // detect | open | reshape | close | sell | sweep | failsafe | sign | recover
    outcome: text('outcome').notNull(), // detected | published | landed | confirmed | skipped | blocked | failed | rejected | noop
    severity: text('severity').notNull(), // info | warn | error
    reason: text('reason'), // producer's functional code (decision/cap/filter/Wall B), verbatim — null on progress outcomes
    kind: text('kind'), // open | add | remove | close | claim | sell | buy (leader DLMM action this relates to)
    leader: text('leader'),
    pool: text('pool'),
    leaderPosition: text('leader_position'), // correlates one mirrored position's whole lifecycle
    ourPosition: text('our_position'),
    commandId: text('command_id'), // bus / executions correlation
    eventKey: text('event_key'), // detection correlation
    leaderSizeSol: doublePrecision('leader_size_sol'),
    ourSizeSol: doublePrecision('our_size_sol'),
    signature: text('signature'), // on-chain tx sig (landed) or leader trigger sig (detect)
    latencyMs: integer('latency_ms'), // build+publish (brain) or sign+land (coffre)
    detail: jsonb('detail'), // free-form long tail (bin ranges, fidelity, filter sub-code)
    // ── observability redesign (SPEC §5) — additive + nullable until the call-site cutover (P2). ──────────────
    userId: text('user_id'), // tenant FK → users.id; mono-user PoC = SYSTEM_USER_ID
    wallet: text('wallet'), // the COPY wallet (cfg.ownerPubkey) — THE admin/user filter key
    correlationId: text('correlation_id'), // = command_id ?? event_key — threads one lifecycle + the dedup key
    eventTs: ms('event_ts'), // explicit business/observed time (closes the implicit-ts gap)
    code: text('code'), // canonical `namespace.leaf` CopyCode (back-fills the ad-hoc reason)
    category: text('category'), // denormalized CopyCategory (LIFECYCLE | DETECT | …)
    audience: text('audience'), // internal | feed — the user-feed read-model filters on this
    pinned: boolean('pinned'), // critical-after-retries → surfaced as a feed alert
    deliveredAt: ms('delivered_at'), // future external-push outbox state; unused while feed-only
  },
  (t) => [
    index('idx_copy_journal_ts').on(t.ts), // feed: ORDER BY ts DESC
    index('idx_copy_journal_leader_ts').on(t.leader, t.ts), // per-leader feed
    index('idx_copy_journal_our_position').on(t.ourPosition), // per-position drill-down
    index('idx_copy_journal_wallet_ts').on(t.wallet, t.ts), // all logs (+ feed) for one wallet
    index('idx_copy_journal_user_ts').on(t.userId, t.ts), // admin per-tenant timeline
    index('idx_copy_journal_code').on(t.code), // filter by code (e.g. code LIKE 'wallb.%')
    // Durable dedup backstop (SPEC §6): WS + cursor-poll observations of the same (wallet, correlation, code)
    // collapse to one row even if the in-process LRU was reset (process restart).
    uniqueIndex('uq_copy_journal_wallet_corr_code').on(t.wallet, t.correlationId, t.code),
  ],
);

// Copy-bot process heartbeat + status snapshot (one row per process). Each process upserts its row periodically;
// the web derives online/offline from the freshness of `ts` (see domain/copybot/status.ts) and renders `detail`.
export const copybotStatus = pgTable('copybot_status', {
  process: text('process').primaryKey(), // brain | coffre
  ts: ms('ts').notNull(), // last heartbeat (Date.now)
  detail: jsonb('detail'), // process-specific snapshot (positions/exposure/latency for brain; signing for coffre)
});

// Per-pool DLMM metadata (binStep / SOL side / mints), decoded once from the LbPair account. These are
// immutable on-chain, so caching them here lets the projection skip the per-pool getAccountInfo on every
// boot — the dominant first-sync RPC cost. `sol_side` is null for a non-SOL-quote pool.
export const dlmmPools = pgTable('dlmm_pools', {
  poolAddress: text('pool_address').primaryKey(),
  binStep: integer('bin_step').notNull(),
  solSide: text('sol_side'), // 'X' | 'Y' | null
  mintX: text('mint_x').notNull(),
  mintY: text('mint_y').notNull(),
});

// Per-wallet ingest progress: page backward from newest, persist the boundary signatures so an
// incremental run only fetches what's new and a backfill can resume after an interruption.
export const dlmmIngestCursor = pgTable('dlmm_ingest_cursor', {
  wallet: text('wallet').primaryKey(),
  oldestSig: text('oldest_sig'), // furthest-back signature reached so far
  newestSig: text('newest_sig'), // newest signature seen at last run (incremental floor)
  complete: boolean('complete').notNull().default(false), // reached genesis / end of history
  updatedAt: ms('updated_at').notNull(),
});

// Persisted wallet cash-flow: one row per (wallet, tx) with the wallet's net SOL+WSOL movement and
// whether it's trading (swap / DLMM lifecycle) vs external (CEX in/out). The wallet PnL curve is then
// a pure SQL aggregation over these rows — no live chain paging per request. Populated once at backfill
// (full history) and topped up incrementally on the live cadence; immutable per signature.
export const walletFlows = pgTable(
  'wallet_flows',
  {
    wallet: text('wallet').notNull(),
    signature: text('signature').notNull(),
    ts: ms('ts').notNull(), // unix SECONDS (matches the Helius Enhanced tx.timestamp)
    solFlow: doublePrecision('sol_flow').notNull(), // signed net SOL+WSOL change, in SOL
    isTrading: boolean('is_trading').notNull(),
    type: text('type').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.wallet, t.signature] }), // dedup → re-paging is idempotent
    index('idx_wallet_flows_wallet_ts').on(t.wallet, t.ts),
  ],
);

// Pre-aggregated daily rollup of wallet_flows — one row per (wallet, UTC epoch-day) holding that day's
// summed trading + external SOL. Maintained incrementally as flows are ingested, so serving the PnL
// curve is a read over ~days rows instead of a full scan + per-row date-format over millions of flows
// (measured ~350× on the worst case). The raw wallet_flows stays the source of truth; this is derived.
export const walletFlowDaily = pgTable(
  'wallet_flow_daily',
  {
    wallet: text('wallet').notNull(),
    day: integer('day').notNull(), // UTC epoch-day = floor(ts_seconds / 86400)
    trading: doublePrecision('trading').notNull(),
    external: doublePrecision('external').notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.day] })],
);

// Forward-only Net Worth history: the TRUE on-chain wallet total (tvl + idle) sampled into 15-min
// UTC buckets. There is no reliable historical mark-to-market, so this is only ever written going
// forward from the live `state` stream — last write in a bucket wins. The PK already serves the
// (wallet, bucket) range scan the curve reads.
export const networthSnapshots = pgTable(
  'networth_snapshots',
  {
    wallet: text('wallet').notNull(),
    bucket: integer('bucket').notNull(), // UTC 15-min bucket = floor(unix_seconds / 900)
    ts: ms('ts').notNull(), // epoch ms of the sample that landed in this bucket
    walletTotalSol: doublePrecision('wallet_total_sol').notNull(),
    tvlSol: doublePrecision('tvl_sol').notNull(),
    idleSol: doublePrecision('idle_sol').notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.bucket] })],
);

// Per-wallet flow-ingest progress — same shape/semantics as dlmm_ingest_cursor (page newest→genesis,
// resume from oldestSig, top-up until the previously-seen newestSig).
export const walletFlowCursor = pgTable('wallet_flow_cursor', {
  wallet: text('wallet').primaryKey(),
  oldestSig: text('oldest_sig'),
  newestSig: text('newest_sig'),
  complete: boolean('complete').notNull().default(false),
  updatedAt: ms('updated_at').notNull(),
});

// Browser Web Push subscriptions, per account. An event for a wallet pushes to the subscriptions of
// every account that watches it (join with user_watched_wallets); expired endpoints (404/410) are pruned.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('idx_push_user').on(t.userId)],
);

// --- Multi-tenant accounts (public web). Identity is the Privy DID; sessions are 100% Privy. ---
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  // The Privy user id (`did:privy:...`) = the account identity. The auth hook maps every verified
  // access token's `sub` to this row; there is no password and no local session state.
  privyUserId: text('privy_user_id').notNull().unique(),
  // The account's Privy embedded Solana wallet address — filled by the custody increment (nullable
  // until then). Unique: one wallet is one account's trading identity.
  address: text('address').unique(),
  // The Privy WALLET id (not the address) — the coffre signs by wallet id (Inc.4). Filled at provisioning
  // alongside `address`; nullable until then.
  privyWalletId: text('privy_wallet_id'),
  isOwner: boolean('is_owner').notNull().default(false),
  createdAt: ms('created_at').notNull(),
});

// Copy-bot · Inc.4b — per-account custody activation (SPEC §3). One row per user, home of the resumable
// activation-wizard state AND the per-account `signing_disabled` kill switch the coffre reads at sign time.
// `signing_disabled` starts ON (true) and is cleared only by the SYSTEM reconciler once the account is provably
// ready to sign live (consent done + funded ≥ 1 SOL + ≥ 1 started leader — see domain/copybot/activation.ts).
export const copybotActivation = pgTable('copybot_activation', {
  userId: text('user_id').primaryKey(), // FK → users.id
  privyWalletId: text('privy_wallet_id'), // the account's Privy embedded-wallet id (nullable until provisioned)
  policyId: text('policy_id'), // the per-user Wall A policy id (created at provisioning; nullable until then)
  signerAdded: boolean('signer_added').notNull().default(false), // client ran addSigners → the coffre may sign
  signingDisabled: boolean('signing_disabled').notNull().default(true), // per-user kill switch; starts ON
  activationStep: text('activation_step').notNull().default('consent'), // consent | deposit | export | done
  fundedAt: ms('funded_at'), // first time the wallet was seen holding ≥ the activation minimum
  exportAckAt: ms('export_ack_at'), // user acknowledged the key-export offer (or exported)
  withdrawalAckAt: ms('withdrawal_ack_at'), // user completed a withdrawal (teardown gate, wave 4e)
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

/** Which user watches which wallet. A wallet is monitored by the engine iff ≥1 row references it. */
export const userWatchedWallets = pgTable(
  'user_watched_wallets',
  {
    userId: text('user_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    label: text('label').notNull().default(''),
    color: text('color'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.walletAddress] }),
    index('idx_uww_wallet').on(t.walletAddress),
  ],
);

// Single-use invitation codes gating account creation (beta is invite-tight). A verified Privy login
// with no `users` row must redeem one; the claim is atomic (used_by_user_id set exactly once), so a
// code maps to at most one account (traceable: code → account). Optional expiry; unused codes are
// deletable by the owner.
export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  note: text('note').notNull().default(''),
  createdAt: ms('created_at').notNull(),
  expiresAt: ms('expires_at'), // null = never expires
  usedByUserId: text('used_by_user_id'), // set atomically at redeem; null = still available
  usedAt: ms('used_at'),
});

export const notifRules = pgTable(
  'notif_rules',
  {
    wallet: text('wallet'), // null = global rule (applies to every wallet)
    eventKind: text('event_kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    mode: text('mode').notNull().default('single'),
    threshold: doublePrecision('threshold'),
    oorMinutes: integer('oor_minutes'),
  },
  (t) => [
    // Postgres forbids NULL in a PK and treats NULL as distinct in a plain unique index, so key on
    // COALESCE(wallet,'') to keep global rules (NULL wallet) unique per event kind.
    uniqueIndex('uq_notif_rules_wallet_kind').on(sql`coalesce(${t.wallet}, '')`, t.eventKind),
  ],
);

// --- Near-zero-RPC watcher (Step 2): persisted swap FIFO inputs + WS checkpoint + credit telemetry. ---

// Persisted realized-PnL FIFO inputs: one row per (wallet, tx, mint) clean token↔SOL swap leg, decoded
// once from the unified getTransaction ingest. The FIFO realized-PnL walk reads these from the DB +
// only the new deltas — never re-paging the Enhanced API — so every row is immutable and the upsert is
// idempotent (ON CONFLICT DO NOTHING), which is what makes a restart cost ~0 credits.
export const swapFlows = pgTable(
  'swap_flows',
  {
    wallet: text('wallet').notNull(),
    signature: text('signature').notNull(),
    ts: bigint('ts', { mode: 'number' }).notNull(), // unix SECONDS (matches dlmm_legs.block_time)
    mint: text('mint').notNull(),
    tokenAmount: doublePrecision('token_amount').notNull(), // human token units (decimal-adjusted)
    solAmount: doublePrecision('sol_amount').notNull(), // SOL paid (buy) / received (sell) for this leg
    side: text('side').notNull(), // 'buy' | 'sell'
  },
  (t) => [
    primaryKey({ columns: [t.wallet, t.signature, t.mint] }), // dedup → re-ingest is idempotent
    index('idx_swap_flows_wallet_ts').on(t.wallet, t.ts),
  ],
);

// Per-wallet swap-flow ingest progress — same shape/semantics as wallet_flow_cursor (page newest→genesis,
// resume from oldestSig, top-up until the previously-seen newestSig).
export const swapFlowCursor = pgTable('swap_flow_cursor', {
  wallet: text('wallet').primaryKey(),
  oldestSig: text('oldest_sig'),
  newestSig: text('newest_sig'),
  complete: boolean('complete').notNull().default(false),
  updatedAt: ms('updated_at').notNull(),
});

// Durable transactionSubscribe checkpoint: the last signature + slot ingested for a wallet. A WS
// reconnect/replay resumes from this persisted slot (fromSlot) and dedups by signature, so a crash or a
// dropped socket never misses a leader open/close — the #1 no-miss guarantee of the watcher.
export const walletStreamCursor = pgTable('wallet_stream_cursor', {
  wallet: text('wallet').primaryKey(),
  lastSignature: text('last_signature'),
  lastSlot: bigint('last_slot', { mode: 'number' }), // Solana slot (fits a JS number)
  updatedAt: ms('updated_at').notNull(),
});

// Persisted RPC-credit telemetry rollup — one row per (UTC-day, exact method, wallet, code path) holding
// that bucket's summed call count + credit cost. The CreditMeter flushes its since-last-drain deltas here
// every 60s (ON CONFLICT … += delta), so /debug/rpc shows durable last-7d spend across restarts.
export const rpcCreditDaily = pgTable(
  'rpc_credit_daily',
  {
    day: integer('day').notNull(), // UTC epoch-day = floor(ms / 86_400_000)
    method: text('method').notNull(),
    wallet: text('wallet').notNull().default(''), // '' = call not attributable to a wallet
    codePath: text('code_path').notNull(),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    credits: bigint('credits', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.method, t.wallet, t.codePath] })],
);
