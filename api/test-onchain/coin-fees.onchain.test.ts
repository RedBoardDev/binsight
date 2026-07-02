import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { connection } from './env';
import { Harness } from './harness';
import { pollUntil, sleep } from './util';

// A FRESH, currently-trading pump.fun Token-2022 memecoin + its Meteora DLMM pool (user-supplied). Verified out of
// band: token program = Token-2022 with only metadata extensions (no transfer fee / hook), mint+freeze authority
// renounced, decimals 6; pool owned by the Meteora DLMM program; Jupiter routes BOTH ways (buy via Pump.fun AMM,
// SELL via this DLMM pool) at low impact → the bot can copy it AND sell the residual back to SOL.
const MINT = '9gAVAtdnsrniW3GCwsvDeRPf5eJDjtT9S5bu1j7tpump';
const POOL = 'EFY2SwTZLrLfTAisp8QPpx2WiDeBm1XmmHgwy6smpwkg';

const FEE_HOLD_MS = 300_000; // ★ hold the position OPEN for 5 min (≫ a few seconds) so swap fees accrue on it
const FEE_CHECK_EVERY_MS = 60_000; // log fidelity each minute during the hold (position still alive + tracking)
const OPEN_TIMEOUT_MS = 90_000; // Token-2022 two-sided open = 3 tx (buy → create → deposit)
const COPY_CLOSED_TIMEOUT_MS = 90_000;
const WALLET_SOL_ONLY_TIMEOUT_MS = 120_000; // close-sell + the safety sweep must return the wallet to SOL-only

/** The leader's claimed fee (SOL) from the brain's tee'd log, if a claim event was routed. 0 if none. Matches the
 *  event KIND (claim), not the action — a sub-floor (dust) claim is routed with action:'ignore' but still carries
 *  the real claimSol, and the leader claim event line doesn't include the pool, so we key on kind only (one position
 *  in flight at a time in this test). */
function latestClaimSol(): number {
  try {
    const lines = readFileSync('/tmp/bench-brain.log', 'utf8').split('\n').filter((l) => l.includes('"kind":"claim"'));
    const last = lines.at(-1);
    return last ? (JSON.parse(last) as { claimSol?: number }).claimSol ?? 0 : 0;
  } catch {
    return 0;
  }
}

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · fresh Token-2022 memecoin — LONG hold, fees accrue, copy sells clean', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });

  it('open one-sided full-SOL spot → copy → HOLD 5min (fees) → claim → close → wallet sold back to SOL', async () => {
    const ignore = await h.copierMints(); // pre-existing dust (other bench coins) to ignore in the final clean check
    expect(ignore.has(MINT), 'this fresh coin must NOT already be in the copier wallet (else the clean check is vacuous)').toBe(false);

    // 1) Leader opens a ONE-SIDED, full-SOL SPOT position at the active bin. No token purchase → no Jupiter buy quote
    //    (this longtail Token-2022 has no clean SOL→token route → a two-sided open 400s on the buy). SOL-only liquidity
    //    sits at/below active and earns fees on the swaps crossing the active bin; it also converts toward the token as
    //    price trades down — which the close then sells back to SOL.
    const leaderPos = await h.leaderOpen({ pool: POOL, sol: 0.06, strategy: 'spot' }); // copy = 0.5× = 0.03 > 0.02 min-floor
    const copy = await h.waitForCopy(POOL, OPEN_TIMEOUT_MS);
    console.error(`[coin-fees] leader=${leaderPos} copy=${copy}`);

    // 2) Fidelity: the copy landed at ~half the leader's SOL (one-sided → no token leg AT OPEN; tokenLegRatio grows
    //    only as fees/price-conversion accrue, so we only assert the SOL leg here).
    const f = await h.fidelity(POOL, leaderPos, copy);
    expect(f.solLegRatio, `SOL leg not ~half (got ${f.solLegRatio})`).toBeGreaterThan(0.4);
    expect(f.solLegRatio, `SOL leg over half (got ${f.solLegRatio})`).toBeLessThan(0.62);

    // 2b) ★ IN-RANGE check — fees only accrue when the active bin is WITHIN the position. Confirm the copy opened in
    //     range (active ∈ [lower, upper]); a fully out-of-range open would earn nothing no matter how long we hold.
    const sh0 = await h.copierShape(copy, POOL);
    const inRange0 = sh0.lowerBinId <= sh0.activeBinId && sh0.activeBinId <= sh0.upperBinId;
    console.error(`[coin-fees] copy range [${sh0.lowerBinId}..${sh0.upperBinId}] active=${sh0.activeBinId} → ${inRange0 ? 'IN RANGE ✓' : 'OUT OF RANGE ✗'} (width=${sh0.upperBinId - sh0.lowerBinId + 1} bins)`);
    expect(inRange0, 'copy opened OUT OF RANGE — it cannot accrue fees; widen the position / re-center on active').toBe(true);

    // 3) HOLD — keep the position open 3 min so fees accrue from organic pool swaps; confirm it stays alive + tracked.
    const held = Date.now();
    while (Date.now() - held < FEE_HOLD_MS) {
      await sleep(Math.min(FEE_CHECK_EVERY_MS, held + FEE_HOLD_MS - Date.now()));
      expect(await h.accountExists(copy), 'copy position vanished during the hold (should stay open)').toBe(true);
      await h.fidelity(POOL, leaderPos, copy).catch(() => undefined); // logs the live ratio; tolerate a transient read
      const sh = await h.copierShape(copy, POOL).catch(() => null); // track whether the active bin is still in our range
      if (sh) console.error(`[coin-fees] +${Math.round((Date.now() - held) / 1000)}s active=${sh.activeBinId} range[${sh.lowerBinId}..${sh.upperBinId}] ${sh.lowerBinId <= sh.activeBinId && sh.activeBinId <= sh.upperBinId ? 'in-range' : 'OUT'}`);
    }

    // 4) Claim fees while still holding (the bot must copy the claim). Best-effort: a quiet pool may have ~0 fees, in
    //    which case leader-control claim no-ops — that's fine, the close also claims. Report whatever was earned.
    await h.leaderClaim(POOL).catch(() => undefined);
    await sleep(8000); // let the claim route + the bot copy it
    console.error(`[coin-fees] leader claimed fees: ${latestClaimSol()} SOL`);
    expect(await h.accountExists(copy), 'copy position gone after the claim (a claim must NOT close it)').toBe(true);

    // 5) Close → the copy position must be GONE (no dormant), and the close claims any remaining fees.
    await h.leaderClose(POOL);
    let leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), 25_000, 3000);
    if (!leaderClosed) {
      await h.leaderClose(POOL);
      leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), 25_000, 3000);
    }
    expect(leaderClosed, 'leader close did not land after retry').toBe(true);
    await h.waitForCopyClosed(copy);
    expect(await h.accountExists(copy), 'copy still open after the leader closed — DORMANT position').toBe(false);

    // 6) ★ SELL — the copier wallet must return to SOL-only: the withdrawn token leg + accrued token fees are sold
    //    back to SOL (this coin HAS a Jupiter route, so unlike an illiquid dust coin it must clear, not linger).
    const soldClean = await pollUntil(() => h.copierCleanOf(ignore), WALLET_SOL_ONLY_TIMEOUT_MS, 5000);
    const residual = (await h.copierTokens()).filter((t) => !ignore.has(t.mint) && t.amountRaw >= 100_000n);
    console.error(`[coin-fees] post-close copier residual (new tokens): ${residual.map((t) => `${t.mint.slice(0, 6)}=${t.amountRaw}`).join(', ') || 'NONE (sold clean ✓)'}`);
    expect(soldClean, `copier did NOT sell the coin back to SOL — residual: ${residual.map((t) => `${t.mint}=${t.amountRaw}`).join(', ')}`).toBe(true);
  }, 900_000);
});
