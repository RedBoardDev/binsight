-- Migration 0008: decoding keeps its verdict per transaction, not the events it found.
--
-- decoded_event held every DLMM event as JSON, and nothing read it: accounting reads each raw
-- transaction whole (its balances, transfers and fees, not only the DLMM events), so the stored
-- events could never replace the registry, and re-reading a payload is free. tx_decode stays: it
-- records, per decoder version, whether a transaction was decoded, holds nothing the decoder is
-- about, or failed (with the error), and how it executed on chain.

DROP INDEX decoded_event_by_kind;

DROP TABLE decoded_event;
