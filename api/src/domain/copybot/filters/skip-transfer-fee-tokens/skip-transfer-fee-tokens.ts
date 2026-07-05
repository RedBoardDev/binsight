/**
 * Skip a mint that carries a Token-2022 `TransferFeeConfig` extension. The two-sided deposit path funds the token
 * leg through a flat ~0.1% haircut (`user-runtime` `depositableToken`), which a real transfer-fee mint (fee is
 * typically percent-scale, not 0.1%) defeats — the fee'd transfer lands short and yields a partial/failed two-sided
 * copy (finding #105). We cannot fund both legs faithfully, so we do NOT open (both-or-nothing, `06` §1.4).
 * Source: mint-extensions — a CACHEABLE Token-2022 `getMint` (the extension set is immutable after mint creation,
 * so one fetch per mint serves every open); the pure brick only reads the pre-resolved `hasTransferFee` flag.
 */
import { type FilterBrick, PASS, skip } from '../filter';

export const skipTransferFeeTokens: FilterBrick = {
  id: 'skipTransferFeeTokens',
  family: 'filter',
  scope: 'user-global',
  speedClass: 'cached',
  defaultEnabled: false,
  source: 'mint-extensions',
  safePreset: true,
  enabled: (cfg) => cfg.skipTransferFeeTokens,
  evaluate: (_cfg, candidate, ctx) => {
    if (candidate.nonSolMint === null) return PASS; // no non-SOL mint → no fee'd token to guard against
    if (ctx.hasTransferFee === undefined) return skip('transfer_fee_unavailable'); // unknown ⇒ no open
    return ctx.hasTransferFee ? skip('transfer_fee_token') : PASS;
  },
};
