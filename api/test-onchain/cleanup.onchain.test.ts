import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_COIN_SOL, POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { pollUntil } from './util';

// One-off MAINTENANCE: close EVERY leftover position on both test wallets and confirm they end empty. Leader positions
// are closed directly (leader key via leader-control); orphan COPIES (a copy whose leader pair is already gone) are
// auto-closed by the running bot's reconcile — which is exactly why we boot the bot here instead of touching the
// copier key by hand. Covers all pools the bench has ever opened on.
const POOLS = [
  POOL_STABLE,
  POOL_COIN_SOL,
  'EDeuGoVFTEUvWZvNGQH6UvSs5uk6RLgKTvr3MgY32ouw',
  'EFY2SwTZLrLfTAisp8QPpx2WiDeBm1XmmHgwy6smpwkg',
];

describe.runIf(process.env.ONCHAIN_READY === 'true')('maintenance · close ALL leftover positions on both wallets', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted(); // boot → the reconcile auto-closes any orphan copy (leader pair gone)
    h = new Harness(connection());
  });

  it('both wallets end with ZERO open positions', async () => {
    for (const p of POOLS) await h.leaderCloseAll(p); // close every leader position directly
    // Wait for: leader empty on every pool AND the bot's reconcile to have closed every orphan copy.
    const allClear = await pollUntil(async () => {
      for (const p of POOLS) {
        if ((await h.leaderPositions(p)).length > 0) return false;
        if ((await h.copierPositions(p)).length > 0) return false;
      }
      return true;
    }, 240_000, 4000); // 4000ms poll cadence (this file's original default)
    for (const p of POOLS) console.error(`[cleanup] ${p.slice(0, 6)}… leader=${(await h.leaderPositions(p)).length} copier=${(await h.copierPositions(p)).length}`);
    expect(allClear, 'some position is still open after close-all + reconcile').toBe(true);
  }, 300_000);
});
