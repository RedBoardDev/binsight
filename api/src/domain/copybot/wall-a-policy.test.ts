import { describe, expect, it } from 'vitest';
import { JITO_TIP_ACCOUNTS } from './jito-tip';
import {
  ATA_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  DLMM_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './program-ids';
import {
  buildWallAPolicy,
  WALL_A_ALLOWED_PROGRAMS,
  WALL_A_RULE_ALLOW_PROGRAMS,
  WALL_A_RULE_ALLOW_TRANSFERS,
  WALL_A_RULE_DEFAULT_DENY,
  type WallAPolicyInput,
} from './wall-a-policy';

// A Wall A policy IS the on-TEE security surface: if a rule silently drops or a foreign destination leaks in, a
// compromised process could make the wallet sign an out-of-policy tx. These tests pin exactly WHAT it permits.
const USER = 'ownerWa11etAddress1111111111111111111111111';
const USER_WSOL_ATA = 'userWso1Ata2222222222222222222222222222222';
const OPERATOR_FEE = 'operatorFeeSink333333333333333333333333333';
const CAP = 100_000_000_000; // 100 SOL coarse per-transfer ceiling

const input: WallAPolicyInput = {
  userWallet: USER,
  userOwnedDestinations: [USER_WSOL_ATA],
  operatorFeeAddress: OPERATOR_FEE,
  maxTransferLamports: CAP,
};

const ruleByName = (name: string) => buildWallAPolicy(input).rules.find((r) => r.name === name);

describe('buildWallAPolicy', () => {
  it('is a default-DENY solana 1.0 policy with an explicit trailing deny rule', () => {
    const doc = buildWallAPolicy(input);
    expect(doc.version).toBe('1.0');
    expect(doc.chainType).toBe('solana');
    // WHY: the security model is allowlist. A missing default-deny would make an unmatched instruction ALLOWED.
    expect(doc.defaultAction).toBe('DENY');
    const deny = ruleByName(WALL_A_RULE_DEFAULT_DENY);
    expect(deny?.action).toBe('DENY');
    expect(deny?.conditions).toEqual([]); // matches everything not caught by an ALLOW rule
  });

  it('ALLOWs exactly the copy programs — and NOT the System program (so no SOL-moving ix is blanket-allowed)', () => {
    const programs = ruleByName(WALL_A_RULE_ALLOW_PROGRAMS);
    expect(programs?.action).toBe('ALLOW');
    const value = programs?.conditions[0]?.value as string[];
    // Each allowed program must be present — a dropped one would fail-close a legitimate leg (e.g. a Token-2022 residual).
    for (const p of [
      DLMM_PROGRAM_ID,
      JUPITER_V6_PROGRAM_ID,
      COMPUTE_BUDGET_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ATA_PROGRAM_ID,
    ]) {
      expect(value).toContain(p);
    }
    expect([...value].sort()).toEqual([...WALL_A_ALLOWED_PROGRAMS].sort());
    // WHY: if System were in the program allowlist, a System.Transfer to ANY address would match ALLOW → a drain.
    expect(value).not.toContain(SYSTEM_PROGRAM_ID);
  });

  it('permits System.Transfer ONLY to the own-set ∪ the 8 Jito tips ∪ the operator fee sink, capped', () => {
    const transfers = ruleByName(WALL_A_RULE_ALLOW_TRANSFERS);
    expect(transfers?.action).toBe('ALLOW');
    const dest = transfers?.conditions.find((c) => c.field === 'Transfer.to');
    const lamports = transfers?.conditions.find((c) => c.field === 'Transfer.lamports');

    const expected = [
      USER,
      USER_WSOL_ATA,
      OPERATOR_FEE,
      ...JITO_TIP_ACCOUNTS.map((a) => a.toBase58()),
    ].sort();
    expect(dest?.operator).toBe('in');
    expect([...(dest?.value as string[])].sort()).toEqual(expected);
    // The lamport ceiling is enforced (defense in depth vs an inflated wrap/tip/fee).
    expect(lamports?.operator).toBe('lte');
    expect(lamports?.value).toBe(String(CAP));
  });

  it('never leaks a foreign destination and is deterministic (re-provisioning is a diffable no-op)', () => {
    const FOREIGN = 'attackerWa11et999999999999999999999999999999';
    const dest = ruleByName(WALL_A_RULE_ALLOW_TRANSFERS)?.conditions.find(
      (c) => c.field === 'Transfer.to',
    );
    expect(dest?.value).not.toContain(FOREIGN);
    // Same input ⇒ byte-identical output.
    expect(buildWallAPolicy(input)).toEqual(buildWallAPolicy(input));
  });

  it('dedups the destination set when an ATA equals the wallet or a tip (no duplicate rules)', () => {
    const doc = buildWallAPolicy({
      ...input,
      userOwnedDestinations: [USER, USER_WSOL_ATA, USER_WSOL_ATA],
    });
    const dest = doc.rules
      .find((r) => r.name === WALL_A_RULE_ALLOW_TRANSFERS)
      ?.conditions.find((c) => c.field === 'Transfer.to')?.value as string[];
    expect(new Set(dest).size).toBe(dest.length);
  });
});
