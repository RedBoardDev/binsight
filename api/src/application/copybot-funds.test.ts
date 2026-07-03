import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { WITHDRAW_RESERVE_LAMPORTS } from '@/domain/copybot/withdrawable';
import type { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';
import { CopybotFundsService } from './copybot-funds';

const log = pino({ level: 'silent' });
const SOL = 1_000_000_000;

function repo(address: string | null, markWithdrawalAck = vi.fn(async () => {})) {
  return {
    resolveSignableWallet: async () =>
      address ? { walletId: 'w', address, signingDisabled: true } : null,
    markWithdrawalAck,
  } as unknown as CopybotActivationRepository;
}

describe('CopybotFundsService — the withdraw helper (read-only, no signing — SPEC §2.2)', () => {
  it('withdrawable = balance − deployed − reserve, with the address + a SOL convenience', async () => {
    const svc = new CopybotFundsService({
      repo: repo('WALLET'),
      balances: async () => 2 * SOL,
      deployedLamports: async () => 0.5 * SOL,
      log,
    });
    const v = await svc.withdrawable('u1');
    expect(v.address).toBe('WALLET');
    expect(v.balanceLamports).toBe(2 * SOL);
    expect(v.deployedLamports).toBe(0.5 * SOL);
    expect(v.reserveLamports).toBe(WITHDRAW_RESERVE_LAMPORTS);
    expect(v.withdrawableLamports).toBe(1.45 * SOL);
    expect(v.withdrawableSol).toBeCloseTo(1.45);
  });

  it('an unprovisioned wallet (no address) reports zero free and never calls getBalance', async () => {
    const balances = vi.fn(async () => 999);
    const svc = new CopybotFundsService({
      repo: repo(null),
      balances,
      deployedLamports: async () => 0,
      log,
    });
    const v = await svc.withdrawable('u1');
    expect(v.address).toBeNull();
    expect(v.withdrawableLamports).toBe(0);
    expect(balances).not.toHaveBeenCalled();
  });

  it('acknowledgeWithdrawal stamps the ack via the repo (closes the teardown loop)', async () => {
    const markWithdrawalAck = vi.fn(async () => {});
    const svc = new CopybotFundsService({
      repo: repo('WALLET', markWithdrawalAck),
      balances: async () => 0,
      deployedLamports: async () => 0,
      log,
    });
    await svc.acknowledgeWithdrawal('u1');
    expect(markWithdrawalAck).toHaveBeenCalledWith('u1', expect.any(Number));
  });
});
