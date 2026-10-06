import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import type { CaptureScenario, ThemeName } from './parityScenarios';

// The mockup is local and never committed: PARITY_MOCKUP_DIR names its folder, which holds a
// parity.json describing how to show each screen state there:
//
//   { "root": "dist",                       the built mockup, served as static files
//     "query": "?embed=1",                  appended to every path
//     "storage": { "key": "value with {theme}" },  localStorage set before the page loads
//     "screens": { "overview": { "header": {
//       "path": "#/overview",
//       "ready": ["svg[role=img]"],          what must be on the page before the shot
//       "storage": { … },                    this state's own entries, over the shared ones
//       "steps": [...] } } } }

const stepSchema = z.union([
  z.object({ click: z.string() }),
  z.object({ hover: z.string() }),
  z.object({ press: z.string() }),
  z.object({ pointer: z.object({ selector: z.string(), x: z.number(), y: z.number() }) }),
  z.object({ scroll: z.number() }),
]);

const scenarioSchema = z.object({
  path: z.string(),
  ready: z.array(z.string()).min(1),
  storage: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema).optional(),
  fullPage: z.boolean().optional(),
  viewport: z.enum(['desktop', 'mobile']).optional(),
});

const referenceSchema = z.object({
  root: z.string(),
  query: z.string().default(''),
  storage: z.record(z.string(), z.string()).default({}),
  screens: z.record(z.string(), z.record(z.string(), scenarioSchema)),
});

export type MockupReference = z.infer<typeof referenceSchema>;

export const readMockupReference = (folder: string): MockupReference =>
  referenceSchema.parse(JSON.parse(readFileSync(join(folder, 'parity.json'), 'utf8')));

export const mockupScenario = (
  reference: MockupReference,
  screen: string,
  state: string,
): CaptureScenario | undefined => {
  const scenario = reference.screens[screen]?.[state];
  return scenario === undefined
    ? undefined
    : { ...scenario, path: `/${reference.query}${scenario.path}` };
};

// The localStorage entries of one state: the shared ones, then the state's own.
export const mockupStorage = (
  reference: MockupReference,
  screen: string,
  state: string,
  theme: ThemeName,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...reference.storage, ...reference.screens[screen]?.[state]?.storage }).map(
      ([key, value]) => [key, value.replaceAll('{theme}', theme)],
    ),
  );

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

// Static files of the built mockup on a free port of this machine; unknown paths get index.html.
export const serveMockup = (folder: string, reference: MockupReference): Promise<Server> => {
  const root = resolve(folder, reference.root);
  const server = createServer((request, response) => {
    const path = normalize(new URL(request.url ?? '/', 'http://mockup').pathname);
    const candidate = join(root, path);
    const file =
      candidate.startsWith(root) && statSync(candidate, { throwIfNoEntry: false })?.isFile()
        ? candidate
        : join(root, 'index.html');
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => resolveServer(server)));
};

export const serverUrl = (server: Server): string => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the mockup server listens on no TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
};

export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
