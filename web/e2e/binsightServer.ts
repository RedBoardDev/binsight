import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-not-a-secret';

const BINARY = resolve(import.meta.dirname, '../../target/debug/binsight');
const START_TIMEOUT_MS = 30_000;
const LOG_LINES_KEPT = 20;

export interface BinsightServer {
  readonly baseURL: string;
  readonly stop: () => Promise<void>;
}

const readListeningUrl = (line: string): string | null => {
  try {
    const event: unknown = JSON.parse(line);
    if (
      typeof event === 'object' &&
      event !== null &&
      'message' in event &&
      event.message === 'listening' &&
      'url' in event &&
      typeof event.url === 'string'
    ) {
      return event.url;
    }
  } catch {
    // A line that is not JSON is not the one we wait for.
  }
  return null;
};

// Resolves with the server's URL once it listens. Its standard error keeps being read (and the
// last lines kept for an error message), so a full pipe never blocks the server.
const waitForListeningUrl = (child: ChildProcess): Promise<string> =>
  new Promise((resolveUrl, reject) => {
    const lastLines: string[] = [];
    const fail = (reason: string): void =>
      reject(new Error(`${reason}; its last log lines:\n${lastLines.join('\n')}`));
    const timer = setTimeout(
      () => fail('binsight did not start listening in time'),
      START_TIMEOUT_MS,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(`binsight exited with code ${code}`);
    });
    if (child.stderr === null) {
      fail('binsight has no standard error to read');
      return;
    }
    createInterface({ input: child.stderr }).on('line', (line) => {
      lastLines.push(line);
      lastLines.splice(0, lastLines.length - LOG_LINES_KEPT);
      const url = readListeningUrl(line);
      if (url !== null) {
        clearTimeout(timer);
        resolveUrl(url);
      }
    });
  });

const stopProcess = (child: ChildProcess): Promise<void> =>
  new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveStop();
      return;
    }
    child.once('exit', () => resolveStop());
    child.kill('SIGTERM');
  });

// The demo worlds (BINSIGHT_DEMO_WORLD): "nominal" is the calm instance a screen is compared
// against; "showcase" shows every state (a wallet catching up, reconstructed history).
export const DEMO_WORLDS = ['nominal', 'showcase'] as const;
export type DemoWorld = (typeof DEMO_WORLDS)[number];

// A demo frozen at one instant: the same generated world and the same "now" on every start.
export interface FrozenDemo {
  readonly mode: 'frozen-demo';
  readonly now: string;
  readonly world: DemoWorld;
}

const sourceVariables = (mode: 'chain' | 'demo' | FrozenDemo): Readonly<Record<string, string>> => {
  if (mode === 'chain') return { BINSIGHT_HELIUS_API_KEY: 'e2e-placeholder-key' };
  if (mode === 'demo') return { BINSIGHT_DEMO: 'true' };
  return { BINSIGHT_DEMO: 'true', BINSIGHT_DEMO_NOW: mode.now, BINSIGHT_DEMO_WORLD: mode.world };
};

// A fresh server for one test: its own data folder, home folder and port, so no state (the
// login throttle, sessions, the database) leaks from one test into another.
export const startBinsightServer = async (
  mode: 'chain' | 'demo' | FrozenDemo = 'chain',
): Promise<BinsightServer> => {
  const home = mkdtempSync(join(tmpdir(), 'binsight-e2e-'));
  const child = spawn(BINARY, ['run'], {
    env: {
      HOME: home,
      BINSIGHT_DATA_DIR: join(home, 'data'),
      BINSIGHT_PASSWORD: E2E_PASSWORD,
      ...sourceVariables(mode),
      BINSIGHT_BIND: '127.0.0.1:0',
      BINSIGHT_LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const removeHome = (): void => rmSync(home, { recursive: true, force: true });
  try {
    const baseURL = await waitForListeningUrl(child);
    return {
      baseURL,
      stop: async () => {
        await stopProcess(child);
        removeHome();
      },
    };
  } catch (error) {
    await stopProcess(child);
    removeHome();
    throw error;
  }
};
