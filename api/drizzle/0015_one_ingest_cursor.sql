-- One transaction ingest writes legs, cash-flows and swap legs from the same pagination, so the flow
-- and swap cursors were always written identical to dlmm_ingest_cursor. The stream cursor was written
-- on every notification and never read back (logsSubscribe has no replay). Keep the one real cursor.
DROP TABLE IF EXISTS "wallet_flow_cursor";--> statement-breakpoint
DROP TABLE IF EXISTS "swap_flow_cursor";--> statement-breakpoint
DROP TABLE IF EXISTS "wallet_stream_cursor";
