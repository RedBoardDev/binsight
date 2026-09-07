CREATE TABLE "copybot_activation" (
	"user_id" text PRIMARY KEY NOT NULL,
	"privy_wallet_id" text,
	"policy_id" text,
	"signer_added" boolean DEFAULT false NOT NULL,
	"signing_disabled" boolean DEFAULT true NOT NULL,
	"activation_step" text DEFAULT 'consent' NOT NULL,
	"funded_at" bigint,
	"export_ack_at" bigint,
	"withdrawal_ack_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privy_wallet_id" text;