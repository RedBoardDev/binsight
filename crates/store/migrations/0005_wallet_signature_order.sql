-- Listing ordinals are wallet-local fallback metadata, not canonical transaction indices.
-- A late listing inserts an ordinal among previously recorded signatures of the same slot.
-- Keep that update bounded to one slot rather than scanning the wallet's complete history.
CREATE INDEX wallet_signature_by_slot_order
    ON wallet_signature (wallet, slot, slot_order);
