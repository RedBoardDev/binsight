-- Migration 0010: each wallet counts the signatures listed for it.
--
-- The sync report shows how many of a wallet's transactions are in the registry and how far its
-- import is. Counting a wallet's listed signatures walks its whole history; a counter kept in the
-- same transaction as every listed page and every signature the stream records costs nothing to
-- read. Existing wallets start from their current count.

ALTER TABLE wallet_cursor ADD COLUMN listed_count INTEGER NOT NULL DEFAULT 0
    CHECK (listed_count >= 0);

UPDATE wallet_cursor
SET listed_count = (SELECT count(*) FROM wallet_signature AS s WHERE s.wallet = wallet_cursor.wallet);
