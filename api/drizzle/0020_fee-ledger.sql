CREATE TABLE "fee_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"our_position" text NOT NULL,
	"base_pnl_lamports" bigint NOT NULL,
	"fee_lamports" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"sig" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"our_position" text NOT NULL,
	"kind" text NOT NULL,
	"lamports_in" bigint DEFAULT 0 NOT NULL,
	"lamports_out" bigint DEFAULT 0 NOT NULL,
	"sig" text NOT NULL,
	"confirmed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fee_ledger_user_position" ON "fee_ledger" USING btree ("user_id","our_position");--> statement-breakpoint
CREATE INDEX "idx_fee_ledger_state" ON "fee_ledger" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_position_ledger_user_position" ON "position_ledger" USING btree ("user_id","our_position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_position_ledger_user_sig_position" ON "position_ledger" USING btree ("user_id","sig","our_position");