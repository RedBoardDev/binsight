-- Migration 0002: the credits spent on the RPC provider.
--
-- One row per (UTC day, method, priority, purpose, wallet, outcome); each flush of the credit
-- meter adds to the row, so the table answers "where did the credits go" and restores the day's
-- spending after a restart (the hard daily limit survives it). A request is counted whatever its
-- outcome, because the provider may bill it.

CREATE TABLE credit_daily (
    day       TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    method    TEXT NOT NULL,                                -- 'getTransaction'...
    priority  TEXT NOT NULL CHECK (priority IN ('realtime', 'catch_up', 'history', 'valuation')),
    purpose   TEXT NOT NULL CHECK (purpose IN ('history_listing', 'transaction_fetch')),
    wallet    TEXT NOT NULL DEFAULT '',                     -- '' when no wallet is billed
    outcome   TEXT NOT NULL CHECK (outcome IN ('ok', 'rpc_error', 'rate_limited', 'http_error',
                                               'timeout', 'network_error', 'cancelled')),
    calls     INTEGER NOT NULL CHECK (calls >= 0),
    credits   INTEGER NOT NULL CHECK (credits >= 0),
    PRIMARY KEY (day, method, priority, purpose, wallet, outcome)
) STRICT, WITHOUT ROWID;
