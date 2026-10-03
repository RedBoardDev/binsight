-- Migration 0001: the instance metadata and the three data layers.
--
-- Layer 1 (raw_tx) keeps every transaction exactly as the RPC node returned it; it is never
-- updated, so the chain only has to be fetched once.
-- Layer 2 (tx_decode, decoded_event) is derived from layer 1 and tagged with the decoder version
-- that produced it; a new decoder version re-decodes from layer 1 at no RPC cost.
-- Layer 3 (projection tables named proj_*) is disposable and rebuilt by code when its calculation
-- version changes; migrations only create its bookkeeping table, never a projection.
--
-- Tables are STRICT: a value of the wrong type (a REAL amount, for instance) is rejected.
-- Tables only store and index: every rule lives in Rust.

-- Instance metadata: one value per well-known key.
CREATE TABLE app_meta (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
) STRICT;

-- Layer 1: one row per transaction signature.
CREATE TABLE raw_tx (
    signature       TEXT PRIMARY KEY NOT NULL,              -- base58
    slot            INTEGER NOT NULL CHECK (slot >= 0),
    block_time      INTEGER,                                -- Unix seconds; NULL if the node did not say
    tx_version      TEXT NOT NULL,                          -- 'legacy' or the version number
    commitment      TEXT NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
    encoding        TEXT NOT NULL CHECK (encoding IN ('json', 'json_parsed', 'base64')),
    compression     TEXT NOT NULL CHECK (compression IN ('none', 'zstd')),
    payload         BLOB NOT NULL,                          -- the node's answer, untouched
    payload_sha256  BLOB NOT NULL CHECK (length(payload_sha256) = 32),  -- of the uncompressed payload
    fetched_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX raw_tx_by_slot ON raw_tx (slot);

CREATE TRIGGER raw_tx_rows_are_immutable
BEFORE UPDATE ON raw_tx
BEGIN
    SELECT RAISE(ABORT, 'raw_tx rows are immutable');
END;

-- Layer 2: which version of which decoder last read a transaction, and with what outcome.
-- A transaction the decoder has nothing to say about still gets a row ('not_applicable'), so it
-- is not read again until the decoder version changes.
CREATE TABLE tx_decode (
    signature        TEXT NOT NULL REFERENCES raw_tx (signature),
    decoder          TEXT NOT NULL,                         -- for example 'dlmm'
    decoder_version  INTEGER NOT NULL CHECK (decoder_version >= 1),
    outcome          TEXT NOT NULL CHECK (outcome IN ('decoded', 'not_applicable', 'failed')),
    error            TEXT,
    decoded_at       INTEGER NOT NULL,
    PRIMARY KEY (signature, decoder),
    CHECK ((outcome = 'failed') = (error IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX tx_decode_by_version ON tx_decode (decoder, decoder_version);

-- Layer 2: the events a decoder found, replaced as a whole for one (signature, decoder).
CREATE TABLE decoded_event (
    signature        TEXT NOT NULL,
    decoder          TEXT NOT NULL,
    event_index      INTEGER NOT NULL CHECK (event_index >= 0),  -- order inside the transaction
    decoder_version  INTEGER NOT NULL CHECK (decoder_version >= 1),
    kind             TEXT NOT NULL,                         -- for example 'dlmm.add_liquidity'
    payload          TEXT NOT NULL,                         -- JSON; amounts as decimal strings
    PRIMARY KEY (signature, decoder, event_index),
    FOREIGN KEY (signature, decoder) REFERENCES tx_decode (signature, decoder) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX decoded_event_by_kind ON decoded_event (kind);

-- Layer 3: the state of each projection table (proj_<name>).
CREATE TABLE projection_meta (
    name          TEXT PRIMARY KEY NOT NULL CHECK (name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_]*'),
    calc_version  INTEGER NOT NULL CHECK (calc_version >= 1),
    status        TEXT NOT NULL CHECK (status IN ('building', 'ready')),
    built_at      INTEGER,
    CHECK ((status = 'ready') = (built_at IS NOT NULL))
) STRICT;
