import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_STEPS,
  MIN_ACTIVATION_LAMPORTS,
  MIN_ACTIVATION_SOL,
  signingReady,
} from './activation';

describe('activation domain', () => {
  it('the funded floor is 1 SOL in lamports', () => {
    expect(MIN_ACTIVATION_SOL).toBe(1);
    expect(MIN_ACTIVATION_LAMPORTS).toBe(1_000_000_000);
  });

  it('exposes the resumable wizard steps in order', () => {
    expect(ACTIVATION_STEPS).toEqual(['consent', 'deposit', 'export', 'done']);
  });

  describe('signingReady truth table', () => {
    const FUNDED = MIN_ACTIVATION_LAMPORTS;
    const UNDERFUNDED = MIN_ACTIVATION_LAMPORTS - 1;

    // WHY: clearing signing_disabled is a MONEY gate. Each condition alone must be insufficient — the coffre only
    // signs live once consent + funding + a started leader ALL hold (SPEC §3). A regression that drops any one of
    // these would let an under-funded or unconsented account sign.
    it('all three conditions hold ⇒ ready', () => {
      expect(signingReady({ signerAdded: true }, FUNDED, 1)).toBe(true);
    });

    it('no session signer ⇒ not ready (consent not completed)', () => {
      expect(signingReady({ signerAdded: false }, FUNDED, 1)).toBe(false);
    });

    it('under-funded (< 1 SOL) ⇒ not ready', () => {
      expect(signingReady({ signerAdded: true }, UNDERFUNDED, 1)).toBe(false);
    });

    it('exactly at the funded floor ⇒ ready (>= is inclusive)', () => {
      expect(signingReady({ signerAdded: true }, FUNDED, 3)).toBe(true);
    });

    it('no started leader ⇒ not ready (nothing to copy)', () => {
      expect(signingReady({ signerAdded: true }, FUNDED, 0)).toBe(false);
    });
  });
});
