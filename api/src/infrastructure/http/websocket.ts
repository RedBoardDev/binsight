import { ClientMessageSchema, type ServerMessage } from '@binsight/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Engine } from '@/application/engine';
import type { EventBus } from '@/application/event-bus';
import type { AccountRepository } from '@/domain/ports';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import { verifyJwt } from './auth';

interface WsClient {
  socket: WebSocket;
  userId: string;
  /** The connecting token's jti + version — re-checked on a timer so revocation reaches a live socket. */
  jti: string;
  ver: number;
  /** Resolved once at connect — only the owner's heartbeats gate Bark (notifications are owner-only). */
  isOwner: boolean;
  watched: Set<string>;
  /** What the client is viewing: 'all' (its whole watchlist) or one watched address. */
  view: string;
  /** Messages are handled one at a time, in arrival order (a subscribe awaits the watchlist). */
  queue: Promise<void>;
}

export interface LiveDeps {
  secret: string;
  engine: Pick<Engine, 'getState' | 'healthSnapshot' | 'setViewedWallets'>;
  bus: EventBus;
  presence: PresenceTracker;
  accounts: AccountRepository;
  allowedOrigins: string[];
}

/** Messages a socket may send before its authentication resolves; they are replayed once it does. */
const MAX_EARLY_MESSAGES = 16;

/** How often live sockets are re-checked against the account store (revocation + watchlist drift). */
const REVALIDATE_MS = 30_000;

/**
 * A live socket stays authorized only while its account still exists, its token version still matches
 * (a password reset bumps it), and its session jti is still allow-listed (logout / owner-revoke deletes
 * it). The HTTP Bearer hook enforces exactly this, but /live bypasses that hook and authenticates once
 * at upgrade — so without re-checking, a revoked token would keep streaming until the JWT's exp.
 */
export async function sessionStillValid(
  accounts: Pick<AccountRepository, 'findById' | 'isSessionValid'>,
  userId: string,
  ver: number,
  jti: string,
): Promise<boolean> {
  const u = await accounts.findById(userId);
  if (!u || u.tokenVersion !== ver) return false;
  return accounts.isSessionValid(jti);
}

// Shed frames to a client that isn't draining (bufferedAmount past this) instead of growing the heap
// unbounded — a 'state' push is fully superseded by the next one, and a degraded socket is better shed
// than letting one stuck client OOM the process at 50–100 connections.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function send(socket: WebSocket, data: ServerMessage): void {
  if (socket.readyState === socket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES)
    socket.send(JSON.stringify(data));
}

// Broadcast a payload that is IDENTICAL for every recipient: serialize it ONCE and send the same
// frame to all matching sockets, instead of re-JSON.stringify-ing per client. During trading bursts
// (many event/notify across many wallets) this removes N-1 redundant serializations per broadcast.
function sendRaw(socket: WebSocket, frame: string): void {
  if (socket.readyState === socket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES)
    socket.send(frame);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The /live auth token. Native clients (URLSessionWebSocketTask) send it in the Authorization header
 *  so a long-lived JWT never lands in URLs / proxy access logs (S10); browsers can't set WS request
 *  headers, so they pass a short-lived ws-ticket in ?token=. Prefer the header, fall back to the query. */
export function liveToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string | undefined {
  if (authHeader?.startsWith('Bearer '))
    return authHeader.slice('Bearer '.length).trim() || undefined;
  return queryToken;
}

export function registerWebSocket(app: FastifyInstance, deps: LiveDeps): void {
  const { engine, bus, presence, accounts } = deps;
  const clients = new Set<WsClient>();
  const watchedOf = async (userId: string): Promise<Set<string>> =>
    new Set(await accounts.watchedAddresses(userId));

  // The wallets currently on screen ('all' views a whole watchlist, a focused client one wallet): a
  // wallet that gains a viewer is re-read at once, so a returning viewer never sees a stale total.
  const pushViewers = (): void => {
    const viewed = new Set<string>();
    for (const c of clients) {
      if (c.view === 'all') for (const w of c.watched) viewed.add(w);
      else viewed.add(c.view);
    }
    engine.setViewedWallets(viewed);
  };

  const handleMessage = async (client: WsClient, raw: Buffer): Promise<void> => {
    const parsed = ClientMessageSchema.safeParse(safeJson(raw.toString()));
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === 'subscribe') {
      client.watched = await watchedOf(client.userId); // pick up watchlist changes
      if (msg.scope === 'all') {
        client.view = 'all';
        send(client.socket, {
          type: 'state',
          payload: engine.getState([...client.watched], 'all'),
        });
      } else if (client.watched.has(msg.scope)) {
        client.view = msg.scope;
        send(client.socket, { type: 'state', payload: engine.getState([msg.scope], msg.scope) });
      }
      pushViewers();
    } else if (msg.type === 'presence' && client.isOwner) {
      // Notifications are owner-only, so only the owner's devices gate Bark — a viewer's heartbeat
      // must never suppress the owner's push.
      presence.heartbeat(msg.device, msg.active);
    }
  };

  // logLevel silent: a browser's ws ticket travels in ?token=, keep it out of request logs.
  app.get(
    '/live',
    { websocket: true, logLevel: 'silent', config: { public: true } },
    (socket: WebSocket, req) => {
      // Browsers send Origin on an upgrade; refuse any that isn't allow-listed. Native clients send none.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && !deps.allowedOrigins.includes(origin)) {
        app.log.warn({ origin }, 'live WS upgrade rejected: origin not allow-listed (WEB_ORIGINS)');
        socket.close(1008, 'forbidden origin');
        return;
      }

      // Listeners go on synchronously: ws emits nothing to a listener attached later, so a subscribe
      // sent on open was lost and a socket closed during authentication stayed in `clients` forever.
      let client: WsClient | null = null;
      let closed = false;
      const early: Buffer[] = [];
      socket.on('message', (raw: Buffer) => {
        if (!client) {
          if (early.length < MAX_EARLY_MESSAGES) early.push(raw);
          return;
        }
        const c = client;
        c.queue = c.queue.then(() => handleMessage(c, raw)).catch(() => undefined);
      });
      const drop = (): void => {
        closed = true;
        if (client && clients.delete(client)) pushViewers();
      };
      socket.on('close', drop);
      socket.on('error', drop);

      void (async () => {
        const token = liveToken(req.headers.authorization, (req.query as { token?: string }).token);
        const payload = token ? verifyJwt(deps.secret, token) : null;
        const me = payload ? await accounts.findById(payload.sub) : null;
        // /live bypasses the Bearer hook, so enforce the same revocation checks here.
        if (
          !payload ||
          !me ||
          me.tokenVersion !== payload.ver ||
          !(await accounts.isSessionValid(payload.jti))
        ) {
          socket.close(1008, 'unauthorized');
          return;
        }
        const watched = await watchedOf(me.id);
        if (closed) return;
        const c: WsClient = {
          socket,
          userId: me.id,
          jti: payload.jti,
          ver: payload.ver,
          isOwner: me.isOwner,
          watched,
          view: 'all',
          queue: Promise.resolve(),
        };
        client = c;
        clients.add(c);
        pushViewers();
        send(socket, { type: 'state', payload: engine.getState([...watched], 'all') });
        // Health is emit-on-change: hand a new client the current status right away.
        send(socket, { type: 'health', payload: engine.healthSnapshot() });
        for (const raw of early.splice(0)) {
          c.queue = c.queue.then(() => handleMessage(c, raw)).catch(() => undefined);
        }
      })().catch((err) => {
        app.log.warn({ err }, 'live WS setup failed');
        socket.close(1011, 'setup failed');
      });
    },
  );

  // Per-wallet state → clients watching that wallet. The 'all' aggregate is identical for every client
  // sharing a watchlist, so it is computed once per distinct watchlist per emit.
  bus.on('state', (state) => {
    const aggByWatch = new Map<string, ReturnType<typeof engine.getState>>();
    for (const c of clients) {
      if (!c.watched.has(state.scope)) continue;
      if (c.view === 'all') {
        const key = [...c.watched].sort().join(',');
        let agg = aggByWatch.get(key);
        if (!agg) {
          agg = engine.getState([...c.watched], 'all');
          aggByWatch.set(key, agg);
        }
        send(c.socket, { type: 'state', payload: agg });
      } else if (c.view === state.scope) {
        send(c.socket, { type: 'state', payload: state });
      }
    }
  });
  // Frames identical for every recipient are serialized once. Events and notifications are scoped to
  // their wallet so they never leak across tenants.
  const broadcast = (message: ServerMessage, wallet: string | null): void => {
    const frame = JSON.stringify(message);
    for (const c of clients) if (wallet === null || c.watched.has(wallet)) sendRaw(c.socket, frame);
  };
  bus.on('event', (event) => broadcast({ type: 'event', payload: event }, event.wallet));
  bus.on('notify', (event) => broadcast({ type: 'notify', payload: event }, event.wallet));
  bus.on('closedChanged', (e) => broadcast({ type: 'closed_changed', wallet: e.wallet }, e.wallet));
  bus.on('health', (health) => broadcast({ type: 'health', payload: health }, null));

  // Revocation and watchlist changes don't reach an open socket (it authenticates once), so re-check
  // every client on a timer: close revoked ones, refresh each watched set.
  const revalidate = setInterval(async () => {
    if (clients.size === 0) return;
    const watchedByUser = new Map<string, Set<string>>();
    for (const c of [...clients]) {
      if (c.socket.readyState !== c.socket.OPEN) continue;
      if (!(await sessionStillValid(accounts, c.userId, c.ver, c.jti))) {
        c.socket.close(1008, 'session revoked');
        continue;
      }
      let watched = watchedByUser.get(c.userId);
      if (!watched) {
        watched = await watchedOf(c.userId);
        watchedByUser.set(c.userId, watched);
      }
      c.watched = watched;
    }
    pushViewers();
  }, REVALIDATE_MS);
  revalidate.unref(); // never keep the process alive just for the revalidation timer
  app.addHook('onClose', async () => {
    clearInterval(revalidate);
  });
}
