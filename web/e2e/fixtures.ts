import { test as base } from '@playwright/test';
import { startBinsightServer } from './binsightServer';

// Every test gets its own server, unless the configuration names one that is already running
// (E2E_BASE_URL), whose state is then shared.
export const test = base.extend<{ mode: 'chain' | 'demo' }>({
  mode: ['chain', { option: true }],
  baseURL: async ({ baseURL, mode }, use) => {
    if (baseURL !== undefined) {
      await use(baseURL);
      return;
    }
    const server = await startBinsightServer(mode);
    try {
      await use(server.baseURL);
    } finally {
      await server.stop();
    }
  },
});
