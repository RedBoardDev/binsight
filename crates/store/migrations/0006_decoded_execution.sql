-- Decoder success and chain execution success are independent facts.
-- Legacy records do not establish execution success, so their new columns stay NULL.
ALTER TABLE tx_decode ADD COLUMN execution_outcome TEXT
    CHECK (execution_outcome IN ('succeeded', 'failed'));
ALTER TABLE tx_decode ADD COLUMN execution_error TEXT CHECK (
    (execution_outcome IS NULL AND execution_error IS NULL) OR
    (execution_outcome IS 'succeeded' AND execution_error IS NULL) OR
    (execution_outcome IS 'failed' AND execution_error IS NOT NULL)
);
