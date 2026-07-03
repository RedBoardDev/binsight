-- Inc.3a multi-tenant (SPEC §11/§12) — FRESH-START wipe of the copybot execution/mirror/decision rows (SPEC'd:
-- the dev bench re-seeds), so `user_id` can be added NOT NULL without a default and the composite keys apply
-- to a clean slate.
DELETE FROM "executions";--> statement-breakpoint
DELETE FROM "copy_positions";--> statement-breakpoint
DELETE FROM "copy_decisions";--> statement-breakpoint
-- The rug-exit settings-KV blobs are superseded by the row-level rug_exits / rug_exit_pending tables below.
DELETE FROM "settings" WHERE "key" IN ('copybot.rugExited', 'copybot.rugExitPending');--> statement-breakpoint
CREATE TABLE "rug_exit_pending" (
	"user_id" text NOT NULL,
	"our_position" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "rug_exit_pending_user_id_our_position_pk" PRIMARY KEY("user_id","our_position")
);
--> statement-breakpoint
CREATE TABLE "rug_exits" (
	"user_id" text NOT NULL,
	"leader_position" text NOT NULL,
	"exited_at" bigint NOT NULL,
	CONSTRAINT "rug_exits_user_id_leader_position_pk" PRIMARY KEY("user_id","leader_position")
);
--> statement-breakpoint
DROP INDEX "uq_copy_decisions_signature";--> statement-breakpoint
ALTER TABLE "copy_decisions" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_positions" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
-- Composite tenant keys (the columns exist now): drop the single-column PKs (inline PKs from 0013 carry the
-- Postgres default names), then key executions by (user_id, command_id) and copy_positions by
-- (user_id, leader_position) — the same leader event/position copied for two users is two independent rows.
ALTER TABLE "copy_positions" DROP CONSTRAINT "copy_positions_pkey";--> statement-breakpoint
ALTER TABLE "executions" DROP CONSTRAINT "executions_pkey";--> statement-breakpoint
ALTER TABLE "copy_positions" ADD CONSTRAINT "copy_positions_user_id_leader_position_pk" PRIMARY KEY("user_id","leader_position");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_user_id_command_id_pk" PRIMARY KEY("user_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copy_decisions_user_signature" ON "copy_decisions" USING btree ("user_id","signature");
