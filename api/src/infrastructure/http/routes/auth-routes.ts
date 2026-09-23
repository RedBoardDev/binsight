import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WatchlistService } from '@/application/accounts/watchlist-service';
import type { AccountRepository, NoncePurpose } from '@/domain/ports';
import {
  buildSiwsMessage,
  createJwt,
  hashPassword,
  isValidSolanaAddress,
  TOKEN_TTL_SECONDS,
  verifyPassword,
  verifyWalletSignature,
} from '../auth';

export interface AuthRouteDeps {
  secret: string;
  /** The first allowed web origin — binds the SIWS challenge to this app. */
  primaryOrigin: string;
  ownerAddress: string;
  openAccess: boolean;
  accounts: AccountRepository;
  watchlist: WatchlistService;
}

const WS_TICKET_TTL_SECONDS = 60;
const NONCE_TTL_MS = 5 * 60 * 1000; // long enough to read a wallet prompt, short for replay
const MIN_PASSWORD = 8;

// Fixed pause after every failed auth attempt. There is deliberately NO lockout: behind the BFF every
// browser shares one server-side IP (an IP lockout 429'd every web user on one user's failures) and a
// per-account key would let anyone lock a victim out by their public address.
const LOGIN_FAIL_DELAY_MS = 300;
const slowFail = (): Promise<void> => new Promise((r) => setTimeout(r, LOGIN_FAIL_DELAY_MS));

type SignedBody = { address?: unknown; signature?: unknown; nonce?: unknown; password?: unknown };

/** Wallet identity: a one-time signature proves ownership (register, reset); thereafter address +
 *  password is exchanged for a session JWT. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { secret, accounts, watchlist, openAccess } = deps;
  const publicRoute = { config: { public: true } };

  const siwsDomain = (() => {
    try {
      return new URL(deps.primaryOrigin).host;
    } catch {
      return 'binsight';
    }
  })();
  const challengeFor = (address: string, nonce: string): string =>
    buildSiwsMessage({ domain: siwsDomain, uri: deps.primaryOrigin, address, nonce });

  // Login always runs scrypt, against this dummy hash for an unknown address, so the response time
  // cannot reveal which addresses are registered.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'));

  const issueSession = async (userId: string, ver: number) => {
    // Each JWT carries a random session id (jti) backed by an allowlist row: logout/reset revoke it.
    const jti = randomBytes(16).toString('base64url');
    await accounts.createSession(jti, userId, Date.now() + TOKEN_TTL_SECONDS * 1000);
    return { token: createJwt(secret, userId, ver, jti), expiresInSeconds: TOKEN_TTL_SECONDS };
  };

  const createAccount = async (address: string, password: string, isOwner: boolean) => {
    const user = await accounts.createUser({
      address,
      passwordHash: await hashPassword(password),
      isOwner,
    });
    await watchlist.watchRegistration(user.id, address);
    return issueSession(user.id, user.tokenVersion);
  };

  const issueChallenge = async (address: string, purpose: NoncePurpose) => {
    const nonce = randomBytes(24).toString('base64url');
    await accounts.issueNonce(address, nonce, Date.now() + NONCE_TTL_MS, purpose);
    return { nonce, message: challengeFor(address, nonce) };
  };

  /** Validate a signed-challenge body and consume its single-use nonce. Replies and returns null on
   *  any failure; the nonce is consumed BEFORE the signature check so a replay can never pass. */
  const verifySignedChallenge = async (
    body: SignedBody | undefined,
    purpose: NoncePurpose,
    reply: FastifyReply,
  ): Promise<{ address: string; password: string } | null> => {
    const { address, signature, nonce } = body ?? {};
    const password = typeof body?.password === 'string' ? body.password : '';
    if (
      !isValidSolanaAddress(address) ||
      typeof signature !== 'string' ||
      typeof nonce !== 'string' ||
      password.length < MIN_PASSWORD
    ) {
      await slowFail();
      reply.code(400).send({ error: 'address, signature, nonce and password (≥8) required' });
      return null;
    }
    if (!(await accounts.consumeNonce(address, nonce, purpose))) {
      await slowFail();
      reply.code(401).send({ error: 'expired or invalid challenge, restart' });
      return null;
    }
    if (!verifyWalletSignature(challengeFor(address, nonce), signature, address)) {
      await slowFail();
      reply.code(401).send({ error: 'signature verification failed' });
      return null;
    }
    return { address, password };
  };

  // Register step 1: a nonce + the exact message to sign — only for an approved address.
  app.post('/auth/nonce', publicRoute, async (req, reply) => {
    const address = (req.body as { address?: unknown } | undefined)?.address;
    if (!isValidSolanaAddress(address)) {
      await slowFail();
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    if (!openAccess && !(await accounts.isWhitelisted(address))) {
      await slowFail();
      return reply.code(403).send({ error: 'not approved', notWhitelisted: true });
    }
    if (await accounts.findByAddress(address)) {
      return reply.code(409).send({ error: 'account already exists, sign in instead' });
    }
    return issueChallenge(address, 'register');
  });

  // Register step 2: verify the signature over the exact challenge, then create the account.
  app.post('/auth/register', publicRoute, async (req, reply) => {
    const body = req.body as SignedBody | undefined;
    const address = body?.address;
    const password = typeof body?.password === 'string' ? body.password : '';

    // Open access: address + password, no signature — the wallet is not proven to be the caller's
    // (read-only viewing). Except the owner address: owner rights are only ever granted to a signature,
    // or anyone knowing that public address could claim them before the owner registers.
    if (openAccess && address !== deps.ownerAddress) {
      if (!isValidSolanaAddress(address) || password.length < MIN_PASSWORD) {
        await slowFail();
        return reply.code(400).send({ error: 'address and password (≥8) required' });
      }
      if (await accounts.findByAddress(address)) {
        return reply.code(409).send({ error: 'account already exists, sign in instead' });
      }
      return createAccount(address, password, false);
    }

    if (openAccess && typeof body?.signature !== 'string') {
      return reply
        .code(400)
        .send({ error: 'the owner wallet registers by signing', signatureRequired: true });
    }
    if (isValidSolanaAddress(address) && !(await accounts.isWhitelisted(address))) {
      await slowFail();
      return reply.code(403).send({ error: 'not approved', notWhitelisted: true });
    }
    const proven = await verifySignedChallenge(body, 'register', reply);
    if (!proven) return;
    if (await accounts.findByAddress(proven.address)) {
      return reply.code(409).send({ error: 'account already exists' });
    }
    return createAccount(proven.address, proven.password, proven.address === deps.ownerAddress);
  });

  app.post('/auth/login', publicRoute, async (req, reply) => {
    const body = req.body as { address?: unknown; password?: unknown } | undefined;
    const address = body?.address;
    const password = body?.password;
    if (!isValidSolanaAddress(address) || typeof password !== 'string') {
      await slowFail();
      return reply.code(400).send({ error: 'address and password required' });
    }
    const found = await accounts.findByAddress(address);
    const ok = await verifyPassword(password, found ? found.passwordHash : await dummyHash);
    if (!found || !ok) {
      await slowFail();
      return reply.code(401).send({ error: 'invalid address or password' });
    }
    return issueSession(found.user.id, found.user.tokenVersion);
  });

  // Reset step 1: a challenge for ANY valid address (no existence check → no enumeration).
  app.post('/auth/reset/nonce', publicRoute, async (req, reply) => {
    const address = (req.body as { address?: unknown } | undefined)?.address;
    if (!isValidSolanaAddress(address)) {
      await slowFail();
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    return issueChallenge(address, 'reset');
  });

  // Reset step 2: prove the registration wallet → new password, every existing session revoked.
  app.post('/auth/reset', publicRoute, async (req, reply) => {
    const proven = await verifySignedChallenge(req.body as SignedBody | undefined, 'reset', reply);
    if (!proven) return;
    const found = await accounts.findByAddress(proven.address);
    if (!found) {
      await slowFail();
      return reply.code(404).send({ error: 'no account for this wallet' });
    }
    await accounts.resetPassword(found.user.id, await hashPassword(proven.password));
    await accounts.deleteUserSessions(found.user.id);
    // Re-read so the new token carries the bumped version.
    const fresh = await accounts.findById(found.user.id);
    return issueSession(found.user.id, fresh?.tokenVersion ?? found.user.tokenVersion + 1);
  });

  // Real logout: revoke this token's session so it can't be replayed within its TTL.
  app.post('/auth/logout', async (req) => {
    if (req.account) await accounts.deleteSession(req.account.jti);
    return { ok: true };
  });

  // Public feature flags: the login page reads them before any session exists.
  app.get('/config/app', publicRoute, async () => ({ openAccess }));

  // A short-lived ticket for the browser's WebSocket (browsers can't set WS headers, so it travels in
  // the URL). Its `ws` audience makes it useless on every other route.
  app.get('/auth/ws-ticket', async (req) => {
    const a = req.account!;
    return {
      token: createJwt(secret, a.id, a.tokenVersion, a.jti, WS_TICKET_TTL_SECONDS, 'ws'),
      expiresInSeconds: WS_TICKET_TTL_SECONDS,
    };
  });

  app.get('/auth/verify', async () => ({ ok: true }));

  // The caller's own account — drives the web identity badge and hides the admin surface client-side
  // (every admin route re-checks ownership server-side).
  app.get('/auth/me', async (req) => ({
    address: req.account!.address,
    isOwner: req.account!.isOwner,
  }));
}
