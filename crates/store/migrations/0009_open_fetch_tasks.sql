-- Migration 0009: what keeps each wallet behind is read from the open fetch tasks alone.
--
-- The sync status needs, per wallet, the history still to fetch, the failed and parked tasks and
-- the oldest live work waiting. It used to join every signature a wallet ever listed to its task,
-- every 30 seconds, so its cost grew with the history even on an idle instance. These indexes
-- let one query visit only the tasks not fetched yet (none on an idle instance) and find, for
-- each, the wallets that listed it. The signature index costs about 14 MB per 100,000 listed
-- signatures, a fair price for an idle instance that no longer walks its histories.

CREATE INDEX tx_fetch_open ON tx_fetch (signature) WHERE state <> 'fetched';

CREATE INDEX wallet_signature_by_signature ON wallet_signature (signature);
