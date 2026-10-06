-- Migration 0011: raw transactions are never deleted either.
--
-- The registry is fetched once and kept forever; an update was already refused. The decoder also
-- reads the registry in insertion order and remembers how far it read: if the newest row were
-- deleted, SQLite could give its rowid to the next row, behind that position, and the decoder
-- would never read it. Refusing deletes keeps the insertion order strictly growing.

CREATE TRIGGER raw_tx_rows_are_never_deleted
BEFORE DELETE ON raw_tx
BEGIN
    SELECT RAISE(ABORT, 'raw_tx rows are never deleted');
END;
