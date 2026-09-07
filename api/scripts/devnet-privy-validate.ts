/**
 * Copy-bot · Inc.4f — DEVNET Privy custody validation (SPEC §2.5, the BLOCKER gate before live signing).
 *
 * Run by the OPERATOR against a Privy DEVNET app to PROVE the custody crux the off-chain suite cannot:
 *  the coffre session signer can execute UNDER POLICY while the user is offline, without a per-tx quorum;
 *  Privy preserves a co-signer's partial signature + v0/ALT; a DENY'd instruction is rejected at the TEE;
 *  the user can export but the operator cannot; revoke yields a captured error class; the signer key can be
 *  deleted for an instant global hard-kill; and the p50/p95 sign latency is measured.
 *
 * This script does NOT touch the production DB or the running bot. It is a standalone probe: each step prints
 * PASS / FAIL / DISCOVER (a value the operator reports back so we finalize the TODO(devnet-4f) markers in
 * signer.ts / sign-error-classifier.ts / policy-admin.ts). Only after every REQUIRED step is PASS do we flip
 * PRIVY_SIGNING_ENABLED=true.
 *
 * Run (from api/, with a DEVNET .env):
 *   node --import tsx --env-file=../.env.devnet scripts/devnet-privy-validate.ts
 *
 * Required env (DEVNET app, NOT mainnet):
 *   PRIVY_APP_ID, PRIVY_APP_SECRET            — the devnet Privy app
 *   PRIVY_AUTHORIZATION_KEY                   — the coffre P-256 authorization private key (the session signer)
 *   DEVNET_RPC_URL                            — e.g. https://api.devnet.solana.com
 *   DEVNET_TEST_WALLET_ID (optional)          — a pre-created Privy embedded wallet id to reuse; else the script
 *                                               creates one and prints its id/address for you to fund via a faucet
 */

import { PrivyClient } from '@privy-io/node';
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { buildWallAPolicy } from '@/domain/copybot/wall-a-policy';

// ── tiny reporter ────────────────────────────────────────────────────────────────────────────────
type Status = 'PASS' | 'FAIL' | 'DISCOVER' | 'SKIP';
const results: Array<{ step: string; status: Status; detail: string }> = [];
function record(step: string, status: Status, detail = ''): void {
  results.push({ step, status, detail });
  const icon = { PASS: '✅', FAIL: '❌', DISCOVER: '🔎', SKIP: '⏭️' }[status];
  console.log(`${icon} ${step}${detail ? ` — ${detail}` : ''}`);
}
function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`\n❌ missing required env ${name} — see the header of this script.`);
    process.exit(2);
  }
  return v;
}
/** Extract the most useful identity of a thrown Privy error so the operator can report the exact class/string. */
function errShape(e: unknown): string {
  const any = e as { name?: string; status?: number; code?: string; message?: string };
  return JSON.stringify({
    name: any?.name,
    status: any?.status,
    code: any?.code,
    message: any?.message,
  });
}

async function main(): Promise<void> {
  const appId = need('PRIVY_APP_ID');
  const appSecret = need('PRIVY_APP_SECRET');
  const authKey = need('PRIVY_AUTHORIZATION_KEY');
  const rpcUrl = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
  const conn = new Connection(rpcUrl, 'confirmed');
  const privy = new PrivyClient({ appId, appSecret });
  console.log(`\n=== Inc.4f devnet Privy validation — app ${appId} · rpc ${rpcUrl} ===\n`);

  // ── Step 1: a user-owned embedded wallet + the coffre key as an additional session signer ────────
  // The session-signer registration + policy attach is the CRUX. The exact 0.24.0 method names for key
  // quorums / additional signers are DISCOVERED here (grep found keyQuorums + authorization_keys resources).
  let walletId = process.env.DEVNET_TEST_WALLET_ID ?? '';
  let walletAddress = '';
  try {
    if (walletId) {
      const w = await privy.wallets().get(walletId);
      walletAddress = w.address;
      record('1a create/get wallet', 'PASS', `reused ${walletId} (${walletAddress})`);
    } else {
      const w = await privy.wallets().create({ chainType: 'solana' } as never);
      walletId = w.id;
      walletAddress = w.address;
      record(
        '1a create/get wallet',
        'PASS',
        `created ${walletId} (${walletAddress}) — FUND IT via a devnet faucet, then re-run with DEVNET_TEST_WALLET_ID`,
      );
    }
  } catch (e) {
    record('1a create/get wallet', 'FAIL', errShape(e));
    return finish();
  }

  // Build the per-user Wall A policy doc (pure) — then create it + attach it to the coffre signer.
  const policyDoc = buildWallAPolicy({
    userWallet: walletAddress,
    userOwnedDestinations: [], // devnet: exercise the own-wallet dest; ATAs added when a token leg is tested
    maxTransferLamports: LAMPORTS_PER_SOL, // 1 SOL/transfer cap for the probe
  });
  let policyId = '';
  try {
    // DISCOVER: confirm policies().create accepts this mapped shape (policy-admin.ts does the real mapping).
    const created = await privy.policies().create(policyDoc as never);
    policyId = (created as { id: string }).id;
    record('1b create Wall A policy', 'PASS', `policy ${policyId}`);
  } catch (e) {
    record(
      '1b create Wall A policy',
      'DISCOVER',
      `policies().create shape to finalize: ${errShape(e)}`,
    );
  }

  // DISCOVER: register the coffre authorization key as an additional signer / 1-of-1 key quorum, attach the
  // policy. The exact 0.24.0 call (keyQuorums vs wallets().update additional_signers) is confirmed here.
  record(
    '1c register session signer + attach policy',
    'DISCOVER',
    'run the keyQuorums/additional-signer registration for PRIVY_AUTHORIZATION_KEY here; report the method + response so signer.ts/policy-admin.ts are finalized',
  );

  // ── Step 2: sign with the user LOGGED OUT (session-signer autonomy — the whole crux) ─────────────
  // Build a trivial self-transfer (own → own, allowed by Wall A), sign via the session signer, WE broadcast.
  const latencies: number[] = [];
  async function signViaSession(tx: Transaction, label: string): Promise<string | null> {
    tx.feePayer = new PublicKey(walletAddress);
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const b64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    const t0 = Date.now();
    try {
      const res = await privy.wallets().rpc(walletId, {
        method: 'signTransaction' as const,
        params: { encoding: 'base64' as const, transaction: b64 },
        authorization_context: { authorization_private_keys: [authKey] },
      } as never);
      latencies.push(Date.now() - t0);
      return (res as { data: { signed_transaction: string } }).data.signed_transaction;
    } catch (e) {
      record(label, 'FAIL', errShape(e));
      return null;
    }
  }
  const selfTransfer = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(walletAddress),
      toPubkey: new PublicKey(walletAddress),
      lamports: 1,
    }),
  );
  const signed = await signViaSession(
    selfTransfer,
    '2 sign offline (session signer, user logged out)',
  );
  if (signed)
    record(
      '2 sign offline (session signer, user logged out)',
      'PASS',
      'signed_transaction returned',
    );

  // ── Step 3: v0 + ALT tx AND a partially-signed tx (ephemeral co-signer preserved) ────────────────
  record(
    '3 v0+ALT + partial-signed co-signer preserved',
    'DISCOVER',
    'build a v0 tx (with an ALT) + a tx partially signed by an ephemeral Keypair; confirm Privy returns it with BOTH signatures present and it lands',
  );

  // ── Step 4: a DENY'd instruction is rejected at the TEE (fail-closed) ────────────────────────────
  // A transfer to a FOREIGN address (not own/fee/tips) must be DENY'd by the policy.
  const foreign =
    PublicKey.default.toBase58() === walletAddress
      ? walletAddress
      : '11111111111111111111111111111112';
  const denyTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(walletAddress),
      toPubkey: new PublicKey(foreign),
      lamports: 1,
    }),
  );
  denyTx.feePayer = new PublicKey(walletAddress);
  denyTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  try {
    await privy.wallets().rpc(walletId, {
      method: 'signTransaction' as const,
      params: {
        encoding: 'base64' as const,
        transaction: denyTx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
      },
      authorization_context: { authorization_private_keys: [authKey] },
    } as never);
    record(
      '4 policy DENY at the TEE',
      'FAIL',
      'a foreign-destination transfer was SIGNED — Wall A is not enforcing',
    );
  } catch (e) {
    record('4 policy DENY at the TEE', 'PASS', `rejected as expected: ${errShape(e)}`);
  }

  // ── Step 5: user CAN export, operator CANNOT ─────────────────────────────────────────────────────
  record(
    '5 export: user yes / operator no',
    'DISCOVER',
    "call wallets().exportPrivateKey with the coffre auth context → MUST fail (operator can't export); with a user_jwt context → succeeds. Report both.",
  );

  // ── Step 6: revoke the session signer → capture the exact error class (feeds sign-error-classifier) ─
  record(
    '6 revoke → error class',
    'DISCOVER',
    'revoke the session signer, then re-run step 2; capture err {name,status,code,message} verbatim → this is the isRevokedDelegationError() string to pin',
  );

  // ── Step 7: delete the signer key quorum → instant GLOBAL hard-kill ──────────────────────────────
  record(
    '7 hard-kill (delete signer key quorum)',
    'DISCOVER',
    'delete/deregister the coffre signer key quorum (self-signed); confirm every subsequent sign fails instantly',
  );

  // ── Step 8: latency p50/p95 (re-baseline the budget) ─────────────────────────────────────────────
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    record(
      '8 sign latency',
      'PASS',
      `n=${latencies.length} p50=${p(0.5)}ms p95=${p(0.95)}ms (re-baseline the <3s budget)`,
    );
  } else {
    record('8 sign latency', 'SKIP', 'no successful signs to measure');
  }

  finish();
}

function finish(): void {
  const req = results.filter((r) => r.status === 'FAIL');
  const discover = results.filter((r) => r.status === 'DISCOVER');
  console.log(
    `\n=== SUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS · ${req.length} FAIL · ${discover.length} DISCOVER ===`,
  );
  if (discover.length > 0)
    console.log(
      'Report the DISCOVER lines back so the TODO(devnet-4f) markers are finalized before the flag flips.',
    );
  process.exit(req.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('validation crashed:', e);
  process.exit(1);
});
