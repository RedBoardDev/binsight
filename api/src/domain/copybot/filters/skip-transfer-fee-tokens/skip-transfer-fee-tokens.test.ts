import { describe, expect, it } from 'vitest';
import { FILTERS_ALL_OFF, type FilterContext } from '../filter';
import { skipTransferFeeTokens } from './skip-transfer-fee-tokens';

const c = (mint: string | null) => ({ nonSolMint: mint, pool: 'POOL' });
const cfgOn = { ...FILTERS_ALL_OFF, skipTransferFeeTokens: true };
const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  openTokenMints: new Set(),
  ...over,
});

describe('skipTransferFeeTokens — no-open on Token-2022 TransferFeeConfig mints (user-global, cached, mint-extensions)', () => {
  it('off by default, on when toggled', () => {
    expect(skipTransferFeeTokens.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(skipTransferFeeTokens.enabled(cfgOn)).toBe(true);
  });

  it('mint carries a TransferFeeConfig → skip transfer_fee_token (the two-sided deposit haircut cannot fund it)', () => {
    expect(skipTransferFeeTokens.evaluate(cfgOn, c('MINT'), ctx({ hasTransferFee: true }))).toEqual(
      {
        action: 'skip',
        reason: 'transfer_fee_token',
      },
    );
  });

  it('plain SPL / fee-free Token-2022 mint → pass', () => {
    expect(
      skipTransferFeeTokens.evaluate(cfgOn, c('MINT'), ctx({ hasTransferFee: false })),
    ).toEqual({ action: 'pass' });
  });

  it('unreadable/unknown mint (flag unresolved) → skip transfer_fee_unavailable (unknown ⇒ no open)', () => {
    expect(skipTransferFeeTokens.evaluate(cfgOn, c('MINT'), ctx())).toEqual({
      action: 'skip',
      reason: 'transfer_fee_unavailable',
    });
  });

  it('null mint → pass (no non-SOL mint to fee-check)', () => {
    // A fee flag that would otherwise skip must NOT gate a candidate with no non-SOL mint (SOL-only pool).
    expect(skipTransferFeeTokens.evaluate(cfgOn, c(null), ctx({ hasTransferFee: true }))).toEqual({
      action: 'pass',
    });
  });

  it('meta: user-global / mint-extensions / cached / preset ON', () => {
    expect([
      skipTransferFeeTokens.scope,
      skipTransferFeeTokens.source,
      skipTransferFeeTokens.speedClass,
      skipTransferFeeTokens.safePreset,
    ]).toEqual(['user-global', 'mint-extensions', 'cached', true]);
  });
});
