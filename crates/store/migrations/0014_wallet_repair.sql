-- Migration 0014: where each wallet's repair stands, and the credits it spends.
--
-- A repair lists a wallet's signatures again, from the newest down to the last point an earlier
-- repair verified, and refills what the registry lacks: the listing at the finalized commitment
-- is the truth, and a signature it holds that the wallet does not list is a gap. Each wallet
-- keeps that point and when its last repair ended. A wallet without a row was never repaired,
-- and one whose repaired_at is NULL was asked a full repair: either way its next repair lists its
-- whole history. The rows are only bookkeeping, deleted with their wallet.
--
-- The repair's credits are filed under a purpose of their own; credit_daily checks its purposes,
-- so the table is rebuilt with the longer list and its rows are copied unchanged.

CREATE TABLE wallet_repair (
    wallet              TEXT PRIMARY KEY NOT NULL REFERENCES wallet (address) ON DELETE CASCADE,
    verified_signature  TEXT,                               -- everything older is verified
    verified_slot       INTEGER CHECK (verified_slot >= 0),
    repaired_at         INTEGER,                            -- when the last repair ended
    CHECK ((verified_signature IS NULL) = (verified_slot IS NULL)),
    CHECK (repaired_at IS NOT NULL OR verified_signature IS NULL)
) STRICT;

CREATE TABLE credit_daily_next (
    day       TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    method    TEXT NOT NULL,                                -- 'getTransaction', 'ws_open'...
    priority  TEXT NOT NULL CHECK (priority IN ('realtime', 'catch_up', 'history', 'valuation')),
    purpose   TEXT NOT NULL CHECK (purpose IN ('history_listing', 'transaction_fetch', 'top_up',
                                               'live_check', 'live_stream', 'repair')),
    wallet    TEXT NOT NULL DEFAULT '',                     -- '' when no wallet is billed
    outcome   TEXT NOT NULL CHECK (outcome IN ('ok', 'rpc_error', 'rate_limited', 'http_error',
                                               'timeout', 'network_error', 'cancelled')),
    calls     INTEGER NOT NULL CHECK (calls >= 0),
    credits   INTEGER NOT NULL CHECK (credits >= 0),
    PRIMARY KEY (day, method, priority, purpose, wallet, outcome)
) STRICT, WITHOUT ROWID;

INSERT INTO credit_daily_next (day, method, priority, purpose, wallet, outcome, calls, credits)
SELECT day, method, priority, purpose, wallet, outcome, calls, credits FROM credit_daily;

DROP TABLE credit_daily;

ALTER TABLE credit_daily_next RENAME TO credit_daily;
