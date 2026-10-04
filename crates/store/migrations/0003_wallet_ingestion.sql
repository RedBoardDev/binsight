-- Migration 0003: the tracked wallets, how far their history is listed, and the queue of
-- transactions to fetch.
--
-- Listing and fetching are separate on purpose: a listed signature is written, with its fetch
-- task and the cursor move, in one transaction; fetching is a queue per signature. A failed
-- fetch therefore never moves a cursor, and a cursor never moves past a signature that was not
-- written.

CREATE TABLE wallet (
    address   TEXT PRIMARY KEY NOT NULL,                    -- base58
    added_at  INTEGER NOT NULL
) STRICT;

-- How far a wallet's signatures are listed. The top is the newest signature listed; the history
-- is listed from the newest page down to the wallet's first transaction, the next page starting
-- before history_before.
CREATE TABLE wallet_cursor (
    wallet          TEXT PRIMARY KEY NOT NULL REFERENCES wallet (address) ON DELETE CASCADE,
    top_signature   TEXT,
    top_slot        INTEGER CHECK (top_slot >= 0),
    history_before  TEXT,
    history_state   TEXT NOT NULL CHECK (history_state IN ('not_started', 'listing', 'complete')),
    CHECK ((top_signature IS NULL) = (top_slot IS NULL)),
    CHECK ((history_state = 'listing') = (history_before IS NOT NULL)),
    CHECK (history_state <> 'not_started' OR top_signature IS NULL),
    CHECK (history_state <> 'listing' OR top_signature IS NOT NULL)
) STRICT;

-- Every signature listed for a wallet. A transaction that touches two tracked wallets has a row
-- for each, and one fetch task. slot_order is the rank of the signature among the wallet's
-- signatures of its slot, as a listing returned them (0 = the newest); it is NULL until a
-- listing ranks it (a signature seen first by the live stream), and it only orders transactions
-- that are not fetched yet: a fetched transaction carries its exact index in its block.
CREATE TABLE wallet_signature (
    wallet      TEXT NOT NULL REFERENCES wallet (address) ON DELETE CASCADE,
    signature   TEXT NOT NULL,
    slot        INTEGER NOT NULL CHECK (slot >= 0),
    slot_order  INTEGER CHECK (slot_order >= 0),
    block_time  INTEGER,                                    -- Unix seconds; NULL if the node did not say
    is_failed   INTEGER NOT NULL CHECK (is_failed IN (0, 1)),
    listed_at   INTEGER NOT NULL,
    PRIMARY KEY (wallet, signature)
) STRICT, WITHOUT ROWID;

-- Whether each listed transaction is fetched yet, shared by every wallet that lists it.
-- 'fetched' means the raw_tx row exists: both are written in the same transaction. A task waits
-- for next_attempt_at, except once fetched or parked because the node cannot return its version;
-- a parked task records the newest version binsight could read then (max_supported_version), so
-- a binsight that reads newer versions puts it back in the queue.
CREATE TABLE tx_fetch (
    signature        TEXT PRIMARY KEY NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('pending', 'empty_retry', 'failed',
                                                    'unsupported_version', 'fetched')),
    priority         TEXT NOT NULL CHECK (priority IN ('realtime', 'catch_up', 'history')),
    slot             INTEGER NOT NULL CHECK (slot >= 0),
    attempts         INTEGER NOT NULL CHECK (attempts >= 0),
    next_attempt_at  INTEGER,
    last_error       TEXT,
    updated_at       INTEGER NOT NULL,
    max_supported_version  INTEGER CHECK (max_supported_version >= 0),
    CHECK ((next_attempt_at IS NULL) = (state IN ('fetched', 'unsupported_version'))),
    CHECK ((state = 'unsupported_version') = (max_supported_version IS NOT NULL))
) STRICT;

-- When the next task falls due.
CREATE INDEX tx_fetch_next_attempt ON tx_fetch (next_attempt_at) WHERE next_attempt_at IS NOT NULL;

-- The order the fetch worker serves tasks in: the most urgent class first, then the newest slots.
-- The queue holds a whole history while a wallet is imported, so this order is read from an
-- index instead of sorting every waiting task for each batch. The query must repeat the
-- expression exactly for SQLite to use it.
CREATE INDEX tx_fetch_by_urgency
    ON tx_fetch ((CASE priority WHEN 'realtime' THEN 0 WHEN 'catch_up' THEN 1 ELSE 2 END), slot DESC)
    WHERE next_attempt_at IS NOT NULL;
