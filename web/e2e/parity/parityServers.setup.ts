import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  type BinsightServer,
  DEMO_WORLDS,
  type DemoWorld,
  E2E_PASSWORD,
  startBinsightServer,
} from '../binsightServer';
import { closeServer, readMockupReference, serveMockup, serverUrl } from './mockupReference';
import { PARITY_NOW } from './parityScenarios';

const signIn = async (baseURL: string, sessionFile: string): Promise<void> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    await page.goto('/login');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.context().storageState({ path: sessionFile });
  } finally {
    await browser.close();
  }
};

// Global setup of the parity gate: the binary in demo mode, frozen at PARITY_NOW, once per demo
// world, each on a free port and a data folder of its own; the mockup's static files on another
// free port; one sign-in per world, whose session every capture reuses. The URLs reach the tests
// through the environment. Whatever was started is stopped, and the folder holding the session
// cookies removed, at the end or as soon as anything fails.
export default async function startParityServers(): Promise<() => Promise<void>> {
  const mockupFolder = process.env.PARITY_MOCKUP_DIR;
  if (mockupFolder === undefined || mockupFolder === '') {
    throw new Error('Set PARITY_MOCKUP_DIR to the mockup folder that holds parity.json');
  }
  const reference = readMockupReference(mockupFolder);
  const sessions = mkdtempSync(join(tmpdir(), 'binsight-parity-'));
  const apps: BinsightServer[] = [];
  let mockup: Server | undefined;
  const stopAll = async (): Promise<void> => {
    await Promise.all(apps.map((app) => app.stop()));
    if (mockup !== undefined) await closeServer(mockup);
    rmSync(sessions, { recursive: true, force: true });
  };
  try {
    mockup = await serveMockup(mockupFolder, reference);
    process.env.PARITY_MOCKUP_URL = serverUrl(mockup);
    for (const world of DEMO_WORLDS) {
      const app = await startBinsightServer({ mode: 'frozen-demo', now: PARITY_NOW, world });
      apps.push(app);
      const sessionFile = join(sessions, `${world}.json`);
      await signIn(app.baseURL, sessionFile);
      process.env[appUrlVariable(world)] = app.baseURL;
      process.env[sessionVariable(world)] = sessionFile;
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  return stopAll;
}

export const appUrlVariable = (world: DemoWorld): string => `PARITY_APP_URL_${world.toUpperCase()}`;
export const sessionVariable = (world: DemoWorld): string =>
  `PARITY_SESSION_${world.toUpperCase()}`;
