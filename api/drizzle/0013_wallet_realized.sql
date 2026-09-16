CREATE TABLE IF NOT EXISTS "wallet_realized" (
	"wallet" text PRIMARY KEY NOT NULL,
	"trading_pnl_sol" double precision DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
