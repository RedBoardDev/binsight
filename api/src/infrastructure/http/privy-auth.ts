import { type createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

/**
 * Privy access-token verification. The browser holds the Privy token (Privy IS the session layer —
 * no local session table); every API request presents it as a Bearer and this verifier checks it
 * against Privy's per-app JWKS. Identity is the token's `sub`: the Privy DID (`did:privy:...`),
 * mapped to a local `users` row by the auth hook.
 */

/** Issuer claim of every Privy access token — pinned so a token from another IdP never passes. */
const PRIVY_ISSUER = 'privy.io';
/** Privy signs access tokens with ES256 only — pinning the alg blocks alg-confusion forgeries. */
const PRIVY_TOKEN_ALG = 'ES256';
/** Every Privy user id (the `sub` claim) is a DID with this prefix — anything else is not a user. */
const PRIVY_DID_PREFIX = 'did:privy:';
/** Per-app JWKS endpoint (Privy's public signing keys). createRemoteJWKSet caches the fetched keys. */
export const privyJwksUrl = (appId: string): URL =>
  new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`);

export interface PrivyVerifier {
  /** The verified caller's DID, or null on ANY failure — bad input must never throw. */
  verify(token: string): Promise<{ did: string } | null>;
}

export function createPrivyVerifier(opts: {
  /** The Privy application id — the required `aud` of every accepted token. */
  appId: string;
  /** Key source: createRemoteJWKSet(privyJwksUrl(appId)) in prod, createLocalJWKSet in tests. */
  jwks: ReturnType<typeof createRemoteJWKSet> | JWTVerifyGetKey;
}): PrivyVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, opts.jwks, {
          issuer: PRIVY_ISSUER,
          audience: opts.appId,
          algorithms: [PRIVY_TOKEN_ALG],
        });
        const did = payload.sub;
        // The DID shape is part of the contract: a signed token whose sub isn't a Privy user id is
        // still an invalid credential here (defense against tokens minted for other subjects).
        if (typeof did !== 'string' || !did.startsWith(PRIVY_DID_PREFIX)) return null;
        return { did };
      } catch {
        // Expired / wrong signature / wrong aud/iss/alg / malformed — all the same to the caller: 401.
        return null;
      }
    },
  };
}
