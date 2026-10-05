// A stand-in for the binsight API, for the visual review: a signed-in session, a healthy server
// and a live stream that stays open, so screenshots need neither the Rust binary nor a database.
// Run by Node directly (type stripping): a single module with no local import.

import { createServer, type ServerResponse } from 'node:http';

const PORT = Number.parseInt(process.env.STUB_API_PORT ?? '8099', 10);
const HEARTBEAT_INTERVAL_MS = 15_000;

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const sendEvent = (response: ServerResponse, type: string, data: unknown): void => {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
};

createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://stub').pathname;
  switch (path) {
    case '/api/v1/auth/session':
      sendJson(response, 200, { authenticated: true, expires_at: '2026-11-02T12:00:00Z' });
      return;
    case '/api/v1/health':
      sendJson(response, 200, {
        status: 'ok',
        version: '0.1.0',
        database: 'ok',
        engine: 'running',
        rpc: 'unknown',
        stream: 'idle',
      });
      return;
    case '/api/v1/events': {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sendEvent(response, 'engine_status', { type: 'engine_status', status: 'running' });
      const heartbeat = setInterval(
        () =>
          sendEvent(response, 'heartbeat', {
            type: 'heartbeat',
            server_time: new Date().toISOString(),
          }),
        HEARTBEAT_INTERVAL_MS,
      );
      request.on('close', () => clearInterval(heartbeat));
      return;
    }
    default:
      sendJson(response, 404, {
        error: { code: 'not_found', message: 'stub', request_id: 'stub' },
      });
  }
}).listen(PORT, '127.0.0.1', () => console.info(`stub API on http://127.0.0.1:${PORT}`));
