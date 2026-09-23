import type { FastifyInstance } from 'fastify';
import type { PushRepository } from '@/infrastructure/persistence/push-repository';

export interface PushRouteDeps {
  pushRepo: PushRepository;
  /** VAPID public key for PushManager.subscribe ('' when push is disabled server-side). */
  vapidPublicKey: string;
  /** Send a test push to an account's own subscriptions; returns how many were targeted. */
  sendTestPush(userId: string): Promise<number>;
  openAccess: boolean;
}

const MAX_ENDPOINT_LENGTH = 2048;

/** A push endpoint is a browser push service URL: HTTPS on a public host name. Anything else would let
 *  a user aim the server's web-push requests at an arbitrary (internal) address. */
export function isPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (url.protocol !== 'https:' || url.port !== '' || !host.includes('.')) return false;
  if (/(^|\.)(localhost|local|internal)$/.test(host)) return false;
  // IP literals are never push services (v4 dotted quads, v6 in brackets).
  return !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.startsWith('[');
}

/** Browser/PWA Web Push subscriptions. */
export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const { pushRepo } = deps;

  app.get('/push/vapid-public-key', async () => ({ key: deps.vapidPublicKey }));

  app.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>(
    '/push/subscribe',
    async (req, reply) => {
      // Open access disables notifications entirely (the UI hides the toggle; this is the guarantee).
      if (deps.openAccess) return reply.code(403).send({ error: 'notifications disabled' });
      const b = req.body;
      const endpoint = typeof b?.endpoint === 'string' ? b.endpoint : null;
      const p256dh = typeof b?.keys?.p256dh === 'string' ? b.keys.p256dh : null;
      const auth = typeof b?.keys?.auth === 'string' ? b.keys.auth : null;
      if (!endpoint || !p256dh || !auth || !isPushEndpoint(endpoint)) {
        return reply.code(400).send({ error: 'invalid subscription' });
      }
      await pushRepo.save(req.account!.id, { endpoint, p256dh, auth });
      return { ok: true };
    },
  );

  app.post<{ Body: { endpoint?: unknown } }>('/push/unsubscribe', async (req) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
    if (endpoint) await pushRepo.remove(req.account!.id, endpoint);
    return { ok: true };
  });

  // Send a test push to the caller's own devices — verifies the end-to-end pipeline.
  app.post('/push/test', async (req) => ({ sent: await deps.sendTestPush(req.account!.id) }));
}
