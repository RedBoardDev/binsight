/**
 * Copy-bot · COPIER wallet identity guard (fail-closed on the money path, #24).
 *
 * The coffre is the SOLE key holder: it loads the copier keypair and asserts it against the expected owner before it
 * ever signs; the brain scopes detection + observability to the same owner. Shipping a SILENT default — a
 * `.wallets/copier-test.json` path and a hardcoded owner pubkey — meant a real deploy that forgot the env would
 * transact as (or assert against) the bench TEST wallet. So both envs MUST be set explicitly, with NO test default,
 * exactly like the bus-key guard (`bus-key-guard.ts`). PURE + unit-tested; the callers log + process.exit so the
 * boot pattern stays identical to the other missing-env checks (SOLANA_HTTP_URL, BUS_HMAC_KEY, numeric config).
 */

export type CopierOwnerResult = { owner: string } | { error: string };
export type CopierWalletResult = { keypairPath: string; owner: string } | { error: string };

/**
 * Require COPIER_OWNER (the expected copier wallet address the coffre asserts its loaded key against, and the wallet
 * the brain scopes to). Fail-closed: no hardcoded test-wallet default — a real deploy MUST set it.
 */
export function requireCopierOwner(env: { COPIER_OWNER?: string }): CopierOwnerResult {
  const owner = env.COPIER_OWNER;
  if (!owner)
    return {
      error:
        'COPIER_OWNER must be set (no test-wallet default) — fail-closed on the copier identity',
    };
  return { owner };
}

/**
 * Require COPIER_KEYPAIR_PATH + COPIER_OWNER (the coffre's signing wallet). Fail-closed: neither has a test default,
 * so the coffre never silently loads/signs with the bench `.wallets/copier-test.json`. Reuses `requireCopierOwner`
 * for the owner half (one source of truth for the identity rule).
 */
export function requireCopierWallet(env: {
  COPIER_KEYPAIR_PATH?: string;
  COPIER_OWNER?: string;
}): CopierWalletResult {
  const keypairPath = env.COPIER_KEYPAIR_PATH;
  if (!keypairPath)
    return {
      error:
        'COPIER_KEYPAIR_PATH must be set (no test-wallet default) — fail-closed on the signing key path',
    };
  const owner = requireCopierOwner(env);
  if ('error' in owner) return owner;
  return { keypairPath, owner: owner.owner };
}
