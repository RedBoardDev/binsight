-- Fresh start for accounts (SPEC §15): the multi-user DB starts empty — accounts re-onboard via
-- Privy + invite codes. Wallet-keyed on-chain data survives; only account rows (and their watch
-- links) are wiped, which also lets the NOT NULL privy_user_id column be added below.
TRUNCATE user_watched_wallets;--> statement-breakpoint
DELETE FROM users;--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"used_by_user_id" text,
	"used_at" bigint
);
--> statement-breakpoint
ALTER TABLE "auth_nonces" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_whitelist" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "auth_nonces" CASCADE;--> statement-breakpoint
DROP TABLE "auth_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "wallet_whitelist" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privy_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "token_version";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_privy_user_id_unique" UNIQUE("privy_user_id");