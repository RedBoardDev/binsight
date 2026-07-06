import { describe, expect, it } from 'vitest';
import { encodeEnvelope, verifyEnvelope } from '@/infrastructure/bus/envelope';
import {
  assertBusKey,
  DEV_DEFAULT_BUS_KEY,
  deriveHopKeys,
  HOP_KEY_INFO_EVT,
  HOP_KEY_INFO_SIGN,
  MIN_BUS_KEY_LENGTH,
  PRODUCTION_NODE_ENV,
} from './bus-key-guard';

// The bus HMAC is the coffre's ONLY transport auth (the vault is the sole key holder). A silent fallback to the
// public dev default = anyone with Redis access can forge cmd:sign. So the guard MUST fail-closed: boot only with a
// real, non-default, long-enough key, unless the operator explicitly opts into the dev default on this machine.
describe('assertBusKey — fail-closed bus HMAC key resolution (money path)', () => {
  it('accepts a real key (non-default, ≥ min length) and returns it verbatim', () => {
    const key = 'a'.repeat(MIN_BUS_KEY_LENGTH);
    expect(assertBusKey({ BUS_HMAC_KEY: key })).toEqual({ key });
  });

  it('errors when BUS_HMAC_KEY is unset (no silent fallback to the public default)', () => {
    const r = assertBusKey({});
    expect('error' in r).toBe(true);
  });

  it('errors when BUS_HMAC_KEY equals the public dev default and no escape is set', () => {
    const r = assertBusKey({ BUS_HMAC_KEY: DEV_DEFAULT_BUS_KEY });
    expect('error' in r).toBe(true);
  });

  it('allows the dev default ONLY with the explicit COPYBOT_DEV_BUS_KEY=true escape', () => {
    expect(assertBusKey({ COPYBOT_DEV_BUS_KEY: 'true' })).toEqual({ key: DEV_DEFAULT_BUS_KEY });
    // escape also covers an unset BUS_HMAC_KEY (local dev with no key configured at all)
    expect(
      assertBusKey({ BUS_HMAC_KEY: DEV_DEFAULT_BUS_KEY, COPYBOT_DEV_BUS_KEY: 'true' }),
    ).toEqual({ key: DEV_DEFAULT_BUS_KEY });
  });

  it('errors on a too-short key (below the min length) without the escape', () => {
    const r = assertBusKey({ BUS_HMAC_KEY: 'a'.repeat(MIN_BUS_KEY_LENGTH - 1) });
    expect('error' in r).toBe(true);
  });

  it('★ REFUSES the dev escape under NODE_ENV=production (a stale COPYBOT_DEV_BUS_KEY=true never ships the public key)', () => {
    // WHY (silent key mismatch): both processes resolve with process.env, so a dev escape left set in a prod deploy
    // would either serve the PUBLIC key or leave ONE side on the dev default while the other uses a real key — a
    // silent brain/coffre mismatch that fails closed (the coffre DLQs every command) with no symptom on the brain.
    // Under production the escape must ERROR, whether or not BUS_HMAC_KEY is also (mistakenly) the dev default.
    expect(
      'error' in assertBusKey({ COPYBOT_DEV_BUS_KEY: 'true', NODE_ENV: PRODUCTION_NODE_ENV }),
    ).toBe(true);
    expect(
      'error' in
        assertBusKey({
          BUS_HMAC_KEY: DEV_DEFAULT_BUS_KEY,
          COPYBOT_DEV_BUS_KEY: 'true',
          NODE_ENV: PRODUCTION_NODE_ENV,
        }),
    ).toBe(true);
  });

  it('still accepts a REAL key under NODE_ENV=production (only the dev escape is refused, never a real key)', () => {
    const key = 'a'.repeat(MIN_BUS_KEY_LENGTH);
    expect(assertBusKey({ BUS_HMAC_KEY: key, NODE_ENV: PRODUCTION_NODE_ENV })).toEqual({ key });
  });

  it('allows the dev escape under a NON-production NODE_ENV (development / test / unset — local dev is untouched)', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(assertBusKey({ COPYBOT_DEV_BUS_KEY: 'true', NODE_ENV }), NODE_ENV).toEqual({
        key: DEV_DEFAULT_BUS_KEY,
      });
    }
  });
});

// #24 — per-hop key split. One BUS_HMAC_KEY authenticates BOTH hops today; a leak/confusion of one hop's key could
// then forge the other. deriveHopKeys splits the base secret into K_sign (cmd:sign) and K_evt (ev:executed) so each
// hop's key is independent — a message signed for one hop can NEVER be verified with the other hop's key.
describe('deriveHopKeys — per-hop bus keys (K_sign / K_evt)', () => {
  const BASE = 'a'.repeat(MIN_BUS_KEY_LENGTH);

  it('splits the base secret into two DISTINCT keys (neither equals the base)', () => {
    const { kSign, kEvt } = deriveHopKeys(BASE);
    expect(kSign).not.toEqual(kEvt); // the whole point: one leak cannot forge the other hop
    expect(kSign).not.toEqual(BASE);
    expect(kEvt).not.toEqual(BASE);
    // sanity: hex SHA-256 outputs (64 hex chars)
    expect(kSign).toMatch(/^[0-9a-f]{64}$/);
    expect(kEvt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is DETERMINISTIC — both processes booting from the same base derive byte-identical keys (co-deploy agreement)', () => {
    expect(deriveHopKeys(BASE)).toEqual(deriveHopKeys(BASE));
    // a different base yields different per-hop keys (no accidental collision)
    expect(deriveHopKeys(`${BASE}x`).kSign).not.toEqual(deriveHopKeys(BASE).kSign);
  });

  it('the two info labels are distinct + stable (re-wording one would silently rotate that hop key)', () => {
    expect(HOP_KEY_INFO_SIGN).not.toEqual(HOP_KEY_INFO_EVT);
  });

  it('★ cross-hop key isolation: a cmd:sign envelope signed with K_sign does NOT verify with K_evt (key alone rejects)', () => {
    const { kSign, kEvt } = deriveHopKeys(BASE);
    const payload = { commandId: 'c1', kind: 'open' };
    const env = encodeEnvelope('cmd:sign', kSign, payload);
    // SAME hop, WRONG key → rejected: proves the KEY split rejects independently of the hop-binding.
    expect(verifyEnvelope('cmd:sign', kEvt, env)).toBeNull();
    // right key → the round-trip still works.
    expect(verifyEnvelope('cmd:sign', kSign, env)).toEqual(payload);
  });

  it('★ cross-hop key isolation (reverse): an ev:executed envelope signed with K_evt does NOT verify with K_sign', () => {
    const { kSign, kEvt } = deriveHopKeys(BASE);
    const payload = { commandId: 'c1', kind: 'close', signature: 'sig' };
    const env = encodeEnvelope('ev:executed', kEvt, payload);
    expect(verifyEnvelope('ev:executed', kSign, env)).toBeNull(); // wrong hop key → forgery blocked
    expect(verifyEnvelope('ev:executed', kEvt, env)).toEqual(payload); // round-trip intact
  });
});
