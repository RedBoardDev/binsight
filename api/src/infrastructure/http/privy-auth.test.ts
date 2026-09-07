import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPrivyVerifier, type PrivyVerifier } from './privy-auth';

/**
 * The verifier is the API's ONLY authentication boundary (sessions are 100% Privy), so every reject
 * path here is a forgery class that would otherwise be an account takeover. Tokens are minted with a
 * LOCAL ES256 key + createLocalJWKSet — same verification code path as the remote JWKS, no network.
 */

const APP_ID = 'test-privy-app';
const DID = 'did:privy:clx000000000000000000000';
const TOKEN_TTL = '5m';

/** The signing-key type as jose itself exposes it (this tsconfig has no DOM CryptoKey global). */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let signKey: SigningKey;
let verifier: PrivyVerifier;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  signKey = privateKey;
  const jwk = await exportJWK(publicKey);
  verifier = createPrivyVerifier({
    appId: APP_ID,
    jwks: createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] }),
  });
});

/** Mint a token like Privy would, with per-case overrides to build each forgery. */
function mint(over: {
  issuer?: string;
  audience?: string;
  sub?: string | null;
  expiresIn?: string | number;
  key?: SigningKey | Uint8Array;
  alg?: string;
}): Promise<string> {
  let jwt = new SignJWT({})
    .setProtectedHeader({ alg: over.alg ?? 'ES256' })
    .setIssuer(over.issuer ?? 'privy.io')
    .setAudience(over.audience ?? APP_ID)
    .setIssuedAt()
    .setExpirationTime(over.expiresIn ?? TOKEN_TTL);
  if (over.sub !== null) jwt = jwt.setSubject(over.sub ?? DID);
  return jwt.sign(over.key ?? signKey);
}

describe('createPrivyVerifier — the Privy access-token boundary', () => {
  it('accepts a genuine token and returns its DID (the identity every request maps to)', async () => {
    expect(await verifier.verify(await mint({}))).toEqual({ did: DID });
  });

  it('rejects a token minted for ANOTHER Privy app (audience binding)', async () => {
    expect(await verifier.verify(await mint({ audience: 'someone-elses-app' }))).toBeNull();
  });

  it('rejects a token from another issuer (a non-Privy IdP cannot mint identities here)', async () => {
    expect(await verifier.verify(await mint({ issuer: 'evil.example' }))).toBeNull();
  });

  it('rejects an HS256 token (alg-confusion: symmetric signing must never pass an ES256 pin)', async () => {
    const forged = await mint({ alg: 'HS256', key: new TextEncoder().encode('guessable-secret') });
    expect(await verifier.verify(forged)).toBeNull();
  });

  it('rejects a token signed by a DIFFERENT ES256 key (signature forgery)', async () => {
    const other = await generateKeyPair('ES256');
    expect(await verifier.verify(await mint({ key: other.privateKey }))).toBeNull();
  });

  it('rejects an expired token (a stolen token dies with its TTL)', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await verifier.verify(await mint({ expiresIn: past }))).toBeNull();
  });

  it('rejects a signed token whose sub is not a Privy DID (wrong-subject tokens are not users)', async () => {
    expect(await verifier.verify(await mint({ sub: 'user-123' }))).toBeNull();
    expect(await verifier.verify(await mint({ sub: null }))).toBeNull(); // missing sub entirely
  });

  it('returns null (never throws) on garbage input — the guard turns it into a clean 401', async () => {
    expect(await verifier.verify('not-a-jwt')).toBeNull();
    expect(await verifier.verify('')).toBeNull();
    expect(await verifier.verify('a.b.c')).toBeNull();
  });
});
