import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { AppConfig } from '@/config/env';
import { createJwt } from './auth';
import type { PrivyVerifier } from './privy-auth';
import { type RouteDeps, registerRoutes } from './routes';
import { registerWebSocket } from './websocket';

declare module 'fastify' {
  interface FastifyRequest {
    account?: { id: string; isOwner: boolean; address: string | null; privyUserId: string };
    /** The verified Privy DID when NO local account row exists yet (the invite-gate window). */
    privyDid?: string;
  }
}

/** WS tickets are minted per connection and consumed immediately — 60s absorbs any handshake lag. */
const WS_TICKET_TTL_SECONDS = 60;
/** Legacy `ver` claim value on WS tickets — Privy owns token lifecycles now; the field is vestigial. */
const WS_TICKET_VERSION = 0;
/** Legacy `jti` claim value on WS tickets — no session table backs tickets; a fixed marker. */
const WS_TICKET_JTI = 'ws';

/** Everything registerRoutes needs (RouteDeps) plus the server-only app config + token verifier. */
export type ServerDeps = RouteDeps & { config: AppConfig; privyVerifier: PrivyVerifier };

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: { level: deps.config.LOG_LEVEL } });

  // Allowlist for browsers — Auth is the real boundary; this is defense-in-depth.
  await app.register(cors, {
    origin: deps.config.WEB_ORIGINS.split(',').map((o) => o.trim()),
  });
  // maxPayload caps inbound WS frames — client messages (subscribe/presence/ping) are tiny, so 1 MB is
  // generous; it stops a hostile client from pushing huge frames into the server's receive buffer.
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Catch-all error handler: log the real error, return a clean shape (no stack/internals leaked).
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request error');
    const statusCode = (err as { statusCode?: number }).statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    const message = err instanceof Error ? err.message : 'error';
    reply.code(status).send({ error: status >= 500 ? 'internal error' : message });
  });

  // ── Auth: 100% Privy. Every request carries the Privy access token as a Bearer; the hook verifies
  // it against Privy's JWKS (sub = the DID) and maps the DID to a local account row. A verified
  // login with NO account row yet may only redeem an invite code (the account-creation gate). ──────
  const secret = deps.config.AUTH_SECRET; // signs the short-lived WS ticket only

  // Redeem an invite code: the only mutation a verified-but-accountless Privy login may perform.
  // The claim + account creation are one atomic transaction (a code maps to at most one account).
  app.post('/auth/redeem-invite', async (req, reply) => {
    if (req.account) return reply.code(409).send({ error: 'already_registered' });
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== 'string' || code.length === 0) {
      return reply.code(400).send({ error: 'invalid_code' });
    }
    const did = req.privyDid!;
    const result = await deps.accounts.redeemInviteAndCreateUser({
      code,
      privyUserId: did,
      // Owner bootstrap: the operator's DID is configured, not seeded — their redeem creates the
      // owner account. OWNER_PRIVY_DID defaults to '' which can never equal a real DID.
      isOwner: did === deps.config.OWNER_PRIVY_DID,
      now: Date.now(),
    });
    if (!result.ok) {
      // Typed reasons so the client can render a precise gate message; 409 for a burned code (a
      // conflict with its one-time use), 400 for a code that never was / no longer is redeemable.
      if (result.reason === 'used') return reply.code(409).send({ error: 'code_used' });
      if (result.reason === 'expired') return reply.code(400).send({ error: 'code_expired' });
      return reply.code(400).send({ error: 'invalid_code' });
    }
    const { user } = result;
    return reply.send({
      ok: true,
      account: { id: user.id, address: user.address, isOwner: user.isOwner },
    });
  });

  // Short-lived WebSocket ticket (behind the Bearer hook) — encodes the caller's identity so the
  // socket scopes to that account's watchlist. Browsers can't set WS headers, hence the ticket.
  app.get('/auth/ws-ticket', async (req) => ({
    token: createJwt(
      secret,
      req.account!.id,
      WS_TICKET_VERSION,
      WS_TICKET_JTI,
      WS_TICKET_TTL_SECONDS,
    ),
    expiresInSeconds: WS_TICKET_TTL_SECONDS,
  }));

  app.get('/auth/verify', async () => ({ ok: true }));

  // The caller's own account state. Reachable pre-account (a valid Privy login with no row yet) so
  // the client can learn it must show the invite gate rather than guessing from scattered 403s.
  app.get('/auth/me', async (req) =>
    req.account
      ? { registered: true, address: req.account.address, isOwner: req.account.isOwner }
      : { registered: false, needsInvite: true },
  );

  // Public feature flags for the web. No auth: the login page reads it before any session exists.
  // Currently empty — kept as the forward-compat envelope for future flags.
  app.get('/config/app', async () => ({}));

  // Resolve the caller's account from the Bearer Privy token. Deny by default: no/invalid token ⇒
  // 401; valid token without an account row ⇒ 403 needsInvite (except the two gate endpoints).
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (
      path === '/live' || // exact match (self-authenticates) — a prefix match would exempt /live-*
      path === '/health' ||
      path === '/config/app' // public feature flags (read before any session exists)
    ) {
      return;
    }
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const verified = token ? await deps.privyVerifier.verify(token) : null;
    if (!verified) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const user = await deps.accounts.findByPrivyId(verified.did);
    if (user) {
      req.account = {
        id: user.id,
        isOwner: user.isOwner,
        address: user.address,
        privyUserId: user.privyUserId,
      };
      return;
    }
    // Verified Privy identity, no binsight account yet: only the invite-redeem endpoint and the
    // self-describe endpoint may proceed — everything else is behind the invite gate.
    const preAccountAllowed =
      (path === '/auth/redeem-invite' && req.method === 'POST') ||
      (path === '/auth/me' && req.method === 'GET');
    if (!preAccountAllowed) {
      reply.code(403).send({ error: 'no account', needsInvite: true });
      return;
    }
    req.privyDid = verified.did;
  });

  // ServerDeps ⊇ RouteDeps, so hand the deps straight through (no field-by-field re-listing).
  registerRoutes(app, deps);
  registerWebSocket(
    app,
    secret,
    deps.engine,
    deps.bus,
    deps.presence,
    deps.accounts,
    deps.config.WEB_ORIGINS.split(',').map((o) => o.trim()),
  );

  return app;
}
