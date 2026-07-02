CREATE TABLE "copy_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"leader" text NOT NULL,
	"pool" text,
	"position" text,
	"event_kind" text NOT NULL,
	"outcome" text NOT NULL,
	"skip_reason" text,
	"leader_size_sol" double precision DEFAULT 0 NOT NULL,
	"our_size_sol" double precision,
	"block_time" bigint,
	"decided_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_journal" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"process" text NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"severity" text NOT NULL,
	"reason" text,
	"kind" text,
	"leader" text,
	"pool" text,
	"leader_position" text,
	"our_position" text,
	"command_id" text,
	"event_key" text,
	"leader_size_sol" double precision,
	"our_size_sol" double precision,
	"signature" text,
	"latency_ms" integer,
	"detail" jsonb,
	"user_id" text,
	"wallet" text,
	"correlation_id" text,
	"event_ts" bigint,
	"code" text,
	"category" text,
	"audience" text,
	"pinned" boolean,
	"delivered_at" bigint
);
--> statement-breakpoint
CREATE TABLE "copy_positions" (
	"leader_position" text PRIMARY KEY NOT NULL,
	"our_position" text NOT NULL,
	"pool" text NOT NULL,
	"non_sol_symbol" text,
	"size_sol" double precision NOT NULL,
	"lower_bin" integer NOT NULL,
	"upper_bin" integer NOT NULL,
	"status" text NOT NULL,
	"opened_at" bigint NOT NULL,
	"closed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "copybot_status" (
	"process" text PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"command_id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"state" text NOT NULL,
	"deadline_slot" bigint,
	"signature" text,
	"last_valid_block_height" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"leader" text NOT NULL,
	"instruction" text NOT NULL,
	"action" text,
	"deposit_sol" double precision DEFAULT 0 NOT NULL,
	"withdraw_sol" double precision DEFAULT 0 NOT NULL,
	"claim_sol" double precision DEFAULT 0 NOT NULL,
	"pool" text,
	"non_sol_mint" text,
	"non_sol_symbol" text,
	"block_time" bigint,
	"source" text NOT NULL,
	"detected_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copy_decisions_signature" ON "copy_decisions" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "idx_copy_decisions_leader" ON "copy_decisions" USING btree ("leader");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_ts" ON "copy_journal" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_leader_ts" ON "copy_journal" USING btree ("leader","ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_our_position" ON "copy_journal" USING btree ("our_position");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_wallet_ts" ON "copy_journal" USING btree ("wallet","ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_user_ts" ON "copy_journal" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_code" ON "copy_journal" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copy_journal_wallet_corr_code" ON "copy_journal" USING btree ("wallet","correlation_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_leader_activity_signature" ON "leader_activity" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "idx_leader_activity_leader" ON "leader_activity" USING btree ("leader");