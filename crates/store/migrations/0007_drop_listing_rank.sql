-- Migration 0007: listed signatures lose their rank in the slot.
--
-- The rank a listing gave each signature among its wallet's signatures of the same slot was meant
-- to order transactions not fetched yet. Nothing reads it: transactions are ordered by their slot
-- and their index in the block, which every fetched transaction carries. Keeping the rank cost a
-- shift of the other ranks of the slot on every listing, so the column and its index go.

DROP INDEX wallet_signature_by_slot_order;

ALTER TABLE wallet_signature DROP COLUMN slot_order;
