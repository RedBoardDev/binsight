/**
 * Copy-bot — import-firewall (machine-checked). Guarantees the coffre-zone isolation AND domain purity:
 *  F1: ONLY the coffre imports the key (`coffre/keypair.ts`) — the brain cannot name the key.
 *  F1b: ONLY the coffre imports the Privy signing authority (`@privy-io/node`, `coffre/signer.ts`,
 *       `infrastructure/privy/privy-server.ts`) — the brain can never reach the signer (Inc.4a).
 *  F1c: NEITHER the coffre nor the brain imports the GOVERNANCE-key module (`infrastructure/privy/policy-admin.ts`) —
 *       it is API-only (per-user Wall A policy creation); the bot zone must never reach the governance credential (Inc.4b).
 *  F3: the coffre NEVER loads the DLMM SDK (nor the modules that load it) — Wall B re-decodes without the SDK.
 *  D1: src/domain/copybot is the PURE domain — it never imports src/infrastructure; decoders/gateways are
 *      injected via a domain port implemented by an adapter (finding #59). Tests are exempt (they wire adapters).
 * Run from api/:  yarn depcruise src/copybot src/domain/copybot --config .dependency-cruiser.cjs
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'No circular imports anywhere reachable from the copy-bot graph.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'F1-only-coffre-imports-keypair',
      comment: 'The private key is only loaded inside the coffre.',
      severity: 'error',
      from: { pathNot: 'src/copybot/coffre/' },
      to: { path: 'src/copybot/coffre/keypair\\.ts$' },
    },
    {
      name: 'F1b-only-coffre-imports-privy-signer',
      comment:
        'The Privy session signer + its @privy-io/node client (the per-user signing authority) load ONLY inside ' +
        'the coffre — like the keypair. The brain must never reach it. privy-server.ts itself is exempted as the ' +
        'sanctioned facade that owns the @privy-io/node import.',
      severity: 'error',
      from: { pathNot: '(src/copybot/coffre/|src/infrastructure/privy/privy-server\\.ts$)' },
      to: {
        path: '(@privy-io/node|src/copybot/coffre/signer\\.ts$|src/infrastructure/privy/privy-server\\.ts$)',
      },
    },
    {
      name: 'F1c-no-policy-governance-key-in-bot',
      comment:
        'The per-user Wall A policy governance key (infrastructure/privy/policy-admin.ts) is API-only. The coffre ' +
        'and the brain must never import it — a distinct off-host credential from the coffre session signer.',
      severity: 'error',
      from: { path: 'src/copybot/' },
      to: { path: 'src/infrastructure/privy/policy-admin\\.ts$' },
    },
    {
      name: 'F3-no-dlmm-sdk-in-coffre',
      comment: 'The coffre never loads the DLMM SDK (firewall F3); Wall B decodes by hand.',
      severity: 'error',
      from: { path: 'src/copybot/coffre/' },
      to: {
        path: '(@meteora-ag/dlmm|src/infrastructure/solana/dlmm/(dlmm-tx-builder|leader-position-reader))',
      },
    },
    {
      name: 'D1-domain-copybot-pure-no-infra',
      comment:
        'src/domain/copybot is the PURE domain: it must never import from src/infrastructure. Decoders and ' +
        'gateways are inverted behind a domain PORT that an infrastructure adapter implements and injects ' +
        '(finding #59). Test files are exempt — they legitimately wire the real adapters.',
      severity: 'error',
      from: { path: '^src/domain/copybot/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/infrastructure/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    // Keep the copy-bot src graph AND the signing-authority package (@privy-io/node) in scope so F1b can forbid a
    // DIRECT `import '@privy-io/node'` from a non-coffre module — not only via the src wrappers (doNotFollow keeps it a
    // leaf: its own internals are never scanned, so this does not slow the cruise or introduce node_modules cycles).
    includeOnly: ['^src/', 'node_modules/@privy-io/node'],
  },
};
