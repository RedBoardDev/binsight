/**
 * Copy-bot · Inc.4b — the GOVERNANCE-key module. Owns the per-user Wall A policy lifecycle (create at provisioning)
 * via a SINGLE off-host governance credential (`PRIVY_POLICY_GOVERNANCE_KEY`), a credential DISTINCT from the
 * coffre's session-signing authority. Firewall-isolated (dependency-cruiser rule `F1c`): neither the coffre nor the
 * brain may import this module — only the API composition wires it into the activation service.
 *
 * The pure policy SHAPE lives in `domain/copybot/wall-a-policy.ts` (fully unit-tested — it's the security surface);
 * this module only maps that shape onto @privy-io/node 0.24.0's `PolicyCreateParams` and issues the create. The
 * exact Privy field names / owner model are finalized on the devnet run (§2.5.3); the create call carries a
 * TODO(devnet-4f) and is never exercised until the flag flips (provisioning is dry this wave).
 */
import { PrivyClient } from '@privy-io/node';
import { deriveOwnerWsolAta } from '@/domain/copybot/ata';
import { buildWallAPolicy, type WallAPolicyRule } from '@/domain/copybot/wall-a-policy';

/** The `client.policies().create(...)` input type, DERIVED from the installed SDK method (0.24.0 doesn't re-export
 *  `PolicyCreateParams` from the package root). Keeps the create call checked against the real surface. */
type PolicyCreateInput = Parameters<ReturnType<PrivyClient['policies']>['create']>[0];

export interface PolicyAdminConfig {
  appId: string;
  appSecret: string;
  /** The single off-host governance key (P-256, base64 PKCS8) that owns + authorizes per-user policy mutations. */
  governanceKey: string;
  /** The 5%-fee sink allowed as a System.Transfer destination in every user's Wall A policy. */
  operatorFeeAddress: string;
  /** Hard per-transfer lamport cap baked into the policy (defense in depth against an inflated wrap/tip/fee). */
  maxTransferLamports: number;
}

/** The Privy policy name for a per-user Wall A policy (functional identifier — stable, keyed on the wallet). */
export const WALL_A_POLICY_NAME_PREFIX = 'copybot-wall-a';

export class PolicyAdmin {
  private readonly client: PrivyClient;
  constructor(private readonly cfg: PolicyAdminConfig) {
    this.client = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
  }

  /**
   * Create the per-user Wall A policy and return its Privy id. `walletAtaAddresses` are the user's OWN token
   * accounts (their WSOL ATA, at minimum) — permitted System.Transfer destinations alongside the wallet, the Jito
   * tips, and the operator fee sink. The wallet's WSOL ATA is always included (derived) even if not passed.
   */
  async createUserPolicy(input: {
    walletAddress: string;
    walletAtaAddresses: string[];
  }): Promise<{ policyId: string }> {
    const ownedDestinations = [
      ...new Set([deriveOwnerWsolAta(input.walletAddress), ...input.walletAtaAddresses]),
    ];
    const doc = buildWallAPolicy({
      userWallet: input.walletAddress,
      userOwnedDestinations: ownedDestinations,
      operatorFeeAddress: this.cfg.operatorFeeAddress,
      maxTransferLamports: this.cfg.maxTransferLamports,
    });
    const params = {
      version: doc.version,
      chain_type: doc.chainType,
      name: `${WALL_A_POLICY_NAME_PREFIX}:${input.walletAddress}`,
      rules: doc.rules.map(toPrivyRule),
    };
    // TODO(devnet-4f): confirm the policy OWNER model (the governance key as `owner`/`owner_id`) + the exact
    // condition field encoding against the live TEE before the flag flips. The pure doc shape is proven by tests;
    // this create is never issued until PRIVY_SIGNING_ENABLED is on. The one cast: Privy's per-instruction
    // condition is a discriminated union `.map()` can't narrow (a programId + system-source combo isn't a member),
    // so the assembled params are cast to the SDK's derived create-input at this single un-exercised line.
    const policy = await this.client.policies().create(params as unknown as PolicyCreateInput);
    return { policyId: policy.id };
  }
}

/** Map our neutral Wall A rule onto the SDK's policy-rule shape (camelCase fieldSource → snake_case field_source). */
function toPrivyRule(rule: WallAPolicyRule): {
  name: string;
  method: string;
  action: 'ALLOW' | 'DENY';
  conditions: Array<{
    field: string;
    field_source: string;
    operator: string;
    value: string | string[];
  }>;
} {
  return {
    name: rule.name,
    method: rule.method,
    action: rule.action,
    conditions: rule.conditions.map((c) => ({
      field: c.field,
      field_source: c.fieldSource,
      operator: c.operator,
      value: c.value,
    })),
  };
}
