-- Migration 0012: a decoding result records the version of the transaction reader too.
--
-- Decoding a transaction runs the transaction reader, then the DLMM decoder. Only the decoder's
-- version was stored, so a transaction the reader failed on stayed failed after the reader was
-- fixed, until an unrelated decoder change. Results stored before this migration have reader
-- version 0 and are decoded again once. The failed results get an index of their own, so their
-- number is cheap to report.

ALTER TABLE tx_decode ADD COLUMN reader_version INTEGER NOT NULL DEFAULT 0
    CHECK (reader_version >= 0);

CREATE INDEX tx_decode_failed ON tx_decode (decoder) WHERE outcome = 'failed';
