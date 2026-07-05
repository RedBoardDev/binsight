-- finding #102: prior account deletions left push_subscriptions rows with a dangling user_id (the bug this
-- FK closes). Purge those orphans first, else the ADD CONSTRAINT below fails on the pre-existing rows.
DELETE FROM "push_subscriptions" WHERE "user_id" NOT IN (SELECT "id" FROM "users");
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;