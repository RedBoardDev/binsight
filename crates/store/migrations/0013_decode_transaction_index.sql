-- Migration 0013: a decoding result records where its transaction sits in its block.
--
-- Transactions are ordered by their slot and their index in the block (the node's
-- transactionIndex), which only the payload carries. Recording the index with the result lets
-- the startup check count, without reading a single payload, the transactions that cannot be
-- ordered exactly. Results stored before this migration do not hold it, so they are marked as
-- read by reader version 0 and decoded again once, from the registry, without any RPC call.
-- Results whose transaction has no index (the decoder could read it, the payload holds none)
-- get an index of their own, so their number is cheap to report.

ALTER TABLE tx_decode ADD COLUMN transaction_index INTEGER CHECK (transaction_index >= 0);

UPDATE tx_decode SET reader_version = 0;

CREATE INDEX tx_decode_unordered ON tx_decode (decoder)
    WHERE transaction_index IS NULL AND outcome <> 'failed';
