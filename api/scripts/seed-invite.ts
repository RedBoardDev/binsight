/**
 * Bootstrap CLI — mint an invite code directly in the DB (operator-only). Solves the first-account
 * chicken-and-egg: an account needs an invite code, and generating codes via /admin/invites needs an
 * OWNER account, which itself needs a code. Run this ONCE to mint the first code, redeem it to create
 * your account, then (with OWNER_PRIVY_DID set to your DID) that account is the owner and can mint the
 * rest from the admin page.
 *
 *   cd api && node --import tsx --env-file=../.env scripts/seed-invite.ts [note]
 *
 * Prints the code. Single-use; no expiry (pass a note to label it).
 */
import { randomBytes } from 'node:crypto';
import { PostgresAccountRepository } from '@/infrastructure/persistence/account-repository';
import { openDatabase } from '@/infrastructure/persistence/database';

const INVITE_CODE_BYTES = 6; // 12 hex chars — mirrors the /admin/invites generator

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
  const note = process.argv[2] ?? 'bootstrap';
  const db = openDatabase(url);
  const accounts = new PostgresAccountRepository(db);
  const code = randomBytes(INVITE_CODE_BYTES).toString('hex');
  await accounts.createInvite({ code, note, expiresAt: null });
  console.log(
    `\n✅ invite code minted (note: ${note}):\n\n    ${code}\n\nRedeem it in the app to create your account.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('seed-invite failed:', e);
  process.exit(1);
});
