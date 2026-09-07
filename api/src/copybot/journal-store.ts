/**
 * Copy-bot · SYSTEM tenant identity.
 *
 * This module previously hosted the `copy_journal` Postgres adapter (`CopyJournalStore`, a P1 shim over
 * `CopyEvents`/`EventStore`). No production path ever constructed it — the observability seam is `CopyEvents`
 * directly — so the dead class was removed. The file is retained only as the stable home of `SYSTEM_USER_ID`,
 * which the brain, coffre, wallet-spawn and teardown paths import from `@/copybot/journal-store` (so the constant
 * is NOT moved, which would churn those call sites).
 */

/** The tenant id used while the bot is mono-user (env-fixed leader/owner). One named const, not a magic string. */
export const SYSTEM_USER_ID = 'system';
