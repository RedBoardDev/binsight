-- Migration 0015: the token accounts each wallet holds, as the registry last saw them.
--
-- A token transfer to a wallet's token account does not have to name the wallet: a transfer to
-- an associated account that already exists only names the account. Listing the wallet's
-- signatures never finds such a transaction, so the registry would miss a deposit. Each token
-- account a tracked wallet owns is kept with what the newest registry transaction that touched
-- it left: its amount, and whether the wallet still owns it. Once a day the engine reads these
-- accounts on chain and lists the signatures of any whose balance disagrees. The rows are
-- derived from the registry (written again when it is decoded again) and deleted with their
-- wallet.
--
-- The purposes of these reads and listings are added to credit_daily, which is rebuilt with the
-- longer list; its rows are copied unchanged.

CREATE TABLE wallet_token_account (
    wallet          TEXT NOT NULL REFERENCES wallet (address) ON DELETE CASCADE,
    token_account   TEXT NOT NULL,
    mint            TEXT NOT NULL,
    last_signature  TEXT NOT NULL,                  -- the newest registry transaction touching it
    last_slot       INTEGER NOT NULL CHECK (last_slot >= 0),
    last_index      INTEGER CHECK (last_index >= 0), -- that transaction's index in its block
    last_amount     TEXT NOT NULL,                  -- raw amount after it, a decimal integer
    is_owned        INTEGER NOT NULL CHECK (is_owned IN (0, 1)), -- the wallet owns it after it
    PRIMARY KEY (wallet, token_account)
) STRICT, WITHOUT ROWID;

CREATE TABLE credit_daily_next (
    day       TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    method    TEXT NOT NULL,                                -- 'getTransaction', 'ws_open'...
    priority  TEXT NOT NULL CHECK (priority IN ('realtime', 'catch_up', 'history', 'valuation')),
    purpose   TEXT NOT NULL CHECK (purpose IN ('history_listing', 'transaction_fetch', 'top_up',
                                               'live_check', 'live_stream', 'repair',
                                               'balance_check', 'token_account_listing')),
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
