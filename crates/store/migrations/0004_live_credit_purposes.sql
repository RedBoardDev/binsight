-- Migration 0004: the credits of live detection get purposes of their own.
--
-- Live detection lists what each wallet did since its newest listed signature (after the stream
-- was down, and as a guaranteed check) and keeps a WebSocket stream open; the credit report must
-- tell those apart from the history import. credit_daily checks its purposes, so the table is
-- rebuilt with the longer list; its rows are copied unchanged.

CREATE TABLE credit_daily_next (
    day       TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    method    TEXT NOT NULL,                                -- 'getTransaction', 'ws_open'...
    priority  TEXT NOT NULL CHECK (priority IN ('realtime', 'catch_up', 'history', 'valuation')),
    purpose   TEXT NOT NULL CHECK (purpose IN ('history_listing', 'transaction_fetch', 'top_up',
                                               'live_check', 'live_stream')),
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
