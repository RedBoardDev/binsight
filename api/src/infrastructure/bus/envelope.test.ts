import { describe, expect, it } from 'vitest';
import { encodeEnvelope, HMAC_HEX_LEN, verifyEnvelope } from './envelope';

const HOP = 'cmd:sign';
const KEY = 'k_sign_secret';
const payload = { commandId: 'c1', kind: 'open', n: 42 };

describe('envelope HMAC — bus integrity', () => {
  it('round-trip: encode then verify (same hop+key) → the payload', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(verifyEnvelope(HOP, KEY, env)).toEqual(payload);
  });

  it('tampered body → null (we do NOT parse an unauthenticated payload)', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    const tampered = { ...env, body: env.body.replace('42', '999') };
    expect(verifyEnvelope(HOP, KEY, tampered)).toBeNull();
  });

  it('wrong hop → null (domain separation: no cross-hop replay)', () => {
    const env = encodeEnvelope('cmd:execute', KEY, payload);
    expect(verifyEnvelope('cmd:sign', KEY, env)).toBeNull();
  });

  it('wrong key → null', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(verifyEnvelope(HOP, 'autre_cle', env)).toBeNull();
  });

  it('tampered hmac of different length → null (no throw)', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(verifyEnvelope(HOP, KEY, { ...env, hmac: 'deadbeef' })).toBeNull();
  });

  it('a produced MAC is exactly HMAC_HEX_LEN lowercase-hex chars (locks the length the bus guard rejects against)', () => {
    // WHY: RedisBus.parse rejects any `hmac` whose length ≠ HMAC_HEX_LEN BEFORE decoding it (#166 DoS guard). If the
    // MAC algorithm ever changed (e.g. sha512 → 128 hex), that guard would silently reject ALL real traffic — this
    // test fails loud first, forcing HMAC_HEX_LEN + the guard to be updated together.
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(env.hmac).toHaveLength(HMAC_HEX_LEN);
    expect(env.hmac).toMatch(/^[0-9a-f]{64}$/); // sha256 = 32 bytes, hex-encoded
  });
});
