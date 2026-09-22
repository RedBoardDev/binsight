import type { PositionBin, PositionBins } from '@binsight/shared';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import {
  BINS_PER_ARRAY,
  binToArrayIndex,
  decodeBin,
  decodeLbPair,
  decodePosition,
  decodePositionHeader,
  deriveBinArray,
} from './layout';
import { coverageIndices } from './valuation';

const ui = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/** The raw accounts one position's bin distribution is decoded from — exactly what the wallet snapshot's
 *  pinned pass already reads, so a fresh snapshot can serve them without another RPC. */
export interface PositionBinsSource {
  position: Uint8Array;
  lbPair: Uint8Array;
  /** bin-array index → its account data (null when that array was absent). */
  binArrays: Map<number, Uint8Array | null>;
  slot: number;
}

/**
 * Per-bin liquidity distribution of one OPEN position, decoded from on-chain accounts at a single slot
 * (the data behind the Price-Bin histogram). Returns null for a closed/missing position.
 */
export async function fetchPositionBins(
  conn: Connection,
  decimalsOf: (mint: string) => Promise<number>,
  positionAddress: string,
): Promise<PositionBins | null> {
  const pk = new PublicKey(positionAddress);
  const head = await conn.getAccountInfo(pk, 'confirmed');
  if (!head) return null;
  const { lbPair, lowerBinId, upperBinId } = decodePositionHeader(head.data);
  const indices = coverageIndices(lowerBinId, upperBinId);
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(
    [pk, lbPair, ...indices.map((i) => deriveBinArray(lbPair, i))],
    'confirmed',
  );
  if (!value[0] || !value[1]) return null;
  const binArrays = new Map<number, Uint8Array | null>();
  indices.forEach((idx, n) => {
    binArrays.set(idx, value[2 + n]?.data ?? null);
  });
  return binsFromAccounts(
    { position: value[0].data, lbPair: value[1].data, binArrays, slot: context.slot },
    decimalsOf,
  );
}

/** Decode a position's bin distribution from its already-read accounts. Pure apart from `decimalsOf`,
 *  which is cached — so serving from a snapshot costs no RPC for any mint already seen. */
export async function binsFromAccounts(
  src: PositionBinsSource,
  decimalsOf: (mint: string) => Promise<number>,
): Promise<PositionBins> {
  const pos = decodePosition(src.position);
  const lbp = decodeLbPair(src.lbPair);
  const binArray = src.binArrays;
  const context = { slot: src.slot };

  const decX = await decimalsOf(lbp.tokenXMint.toBase58());
  const decY = await decimalsOf(lbp.tokenYMint.toBase58());
  const priceFactor = 1 + lbp.binStep / 10000;

  const bins: PositionBin[] = [];
  for (let b = pos.lowerBinId; b <= pos.upperBinId; b++) {
    const share = pos.shares[b - pos.lowerBinId]!;
    let amountX = 0n;
    let amountY = 0n;
    const ba = binArray.get(binToArrayIndex(b));
    if (share > 0n && ba) {
      const bin = decodeBin(ba, b - binToArrayIndex(b) * BINS_PER_ARRAY);
      if (bin.liquiditySupply > 0n) {
        amountX = (share * bin.amountX) / bin.liquiditySupply;
        amountY = (share * bin.amountY) / bin.liquiditySupply;
      }
    }
    bins.push({
      binId: b,
      price: priceFactor ** b * 10 ** (decX - decY),
      amountX: ui(amountX, decX),
      amountY: ui(amountY, decY),
    });
  }

  return {
    slot: context.slot,
    activeBinId: lbp.activeId,
    binStep: lbp.binStep,
    tokenXMint: lbp.tokenXMint.toBase58(),
    tokenYMint: lbp.tokenYMint.toBase58(),
    bins,
  };
}
