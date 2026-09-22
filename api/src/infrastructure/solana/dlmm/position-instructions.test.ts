import { createHash } from 'node:crypto';
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { utils } from '@coral-xyz/anchor';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  discriminatorOf,
  hasDlmmPositionInstruction,
  positionKindOfDisc,
} from './position-instructions';

/** Build an instruction whose data carries the REAL Anchor discriminator for `name`. */
const ix = (programId: string, name?: string): Record<string, unknown> => ({
  programId,
  accounts: [],
  data:
    name == null
      ? ''
      : utils.bytes.bs58.encode(
          createHash('sha256').update(`global:${name}`).digest().subarray(0, 8),
        ),
});

const tx = (top: unknown[], inner: unknown[] = []): ParsedTransactionWithMeta =>
  ({
    transaction: { message: { instructions: top } },
    meta: { innerInstructions: inner.length > 0 ? [{ index: 0, instructions: inner }] : [] },
  }) as unknown as ParsedTransactionWithMeta;

describe('positionKindOfDisc', () => {
  it('maps each lifecycle family to its kind', () => {
    const disc = (n: string) =>
      createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex');
    expect(positionKindOfDisc(disc('initialize_position'))).toBe('open');
    expect(positionKindOfDisc(disc('add_liquidity_by_strategy2'))).toBe('deposit');
    expect(positionKindOfDisc(disc('remove_liquidity_by_range2'))).toBe('withdraw');
    expect(positionKindOfDisc(disc('claim_fee2'))).toBe('claim');
    expect(positionKindOfDisc(disc('close_position_if_empty'))).toBe('close');
  });

  it('does NOT classify a swap as a position instruction', () => {
    const disc = (n: string) =>
      createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex');
    expect(positionKindOfDisc(disc('swap'))).toBeNull();
    expect(positionKindOfDisc(disc('swap2'))).toBeNull();
  });
});

describe('hasDlmmPositionInstruction', () => {
  it('is true for a position action, at top level or in a CPI', () => {
    expect(
      hasDlmmPositionInstruction(tx([ix(DLMM_PROGRAM_ID, 'remove_liquidity_by_range2')])),
    ).toBe(true);
    expect(
      hasDlmmPositionInstruction(tx([ix('ROUTER')], [ix(DLMM_PROGRAM_ID, 'claim_fee2')])),
    ).toBe(true);
  });

  it('is FALSE when an aggregator merely routes a swap through a DLMM pool', () => {
    // The distinction that keeps a real 0.97 SOL sale from being discarded as position activity.
    expect(hasDlmmPositionInstruction(tx([ix(DLMM_PROGRAM_ID, 'swap2')]))).toBe(false);
  });

  it('ignores other programs and undecodable data without throwing', () => {
    expect(hasDlmmPositionInstruction(tx([ix('OTHER', 'remove_liquidity')]))).toBe(false);
    expect(
      hasDlmmPositionInstruction(tx([{ programId: DLMM_PROGRAM_ID, data: '!!!not base58' }])),
    ).toBe(false);
    expect(hasDlmmPositionInstruction(tx([{ programId: DLMM_PROGRAM_ID }]))).toBe(false);
    expect(hasDlmmPositionInstruction({} as ParsedTransactionWithMeta)).toBe(false);
  });

  it('ignores the Anchor event-CPI self-call that every DLMM tx carries', () => {
    // `emit_cpi` shows up in real DLMM txs alongside the real instruction; it must classify as neither.
    expect(positionKindOfDisc('e445a52e51cb9a1d')).toBeNull();
  });
});

describe('discriminatorOf', () => {
  it('reads the first 8 bytes of base58 instruction data as hex', () => {
    const name = 'close_position2';
    const expected = createHash('sha256')
      .update(`global:${name}`)
      .digest()
      .subarray(0, 8)
      .toString('hex');
    expect(discriminatorOf(ix(DLMM_PROGRAM_ID, name) as never)).toBe(expected);
  });
});
