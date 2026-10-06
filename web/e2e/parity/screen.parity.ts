import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { captureScreen } from './captureScreen';
import { mockupScenario, mockupStorage, readMockupReference } from './mockupReference';
import { APP_SCREENS, THEMES, VIEWPORT_NAMES } from './parityScenarios';
import { appUrlVariable, sessionVariable } from './parityServers.setup';
import { composeSheet } from './paritySheet';

// `just parity <screen>`: for each state of the screen, on a desktop and a phone, dark and light,
// the mockup and the app side by side in one sheet. A review aid, not a pixel test: nothing fails
// on a difference; a person compares the sheets.
const screen = process.env.PARITY_SCREEN ?? '';
const states = APP_SCREENS[screen];
if (states === undefined) {
  throw new Error(
    `Unknown screen "${screen}"; the parity gate knows: ${Object.keys(APP_SCREENS).join(', ')}`,
  );
}
const outDir = process.env.PARITY_OUT_DIR ?? join('test-results', 'parity', screen);
const environment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is set by the parity global setup`);
  return value;
};

for (const [state, scenario] of Object.entries(states)) {
  for (const viewport of VIEWPORT_NAMES) {
    if (scenario.viewport !== undefined && scenario.viewport !== viewport) continue;
    for (const theme of THEMES) {
      const name = `${screen}-${state}-${viewport}-${theme}`;
      test(name, async ({ browser }) => {
        const mockupFolder = environment('PARITY_MOCKUP_DIR');
        const reference = readMockupReference(mockupFolder);
        const mockupSide = mockupScenario(reference, screen, state);
        const world = scenario.world ?? 'nominal';
        const app = await captureScreen(browser, {
          baseURL: environment(appUrlVariable(world)),
          scenario,
          viewport,
          theme,
          storageState: environment(sessionVariable(world)),
        });
        const mockup =
          mockupSide === undefined
            ? null
            : await captureScreen(browser, {
                baseURL: environment('PARITY_MOCKUP_URL'),
                scenario: mockupSide,
                viewport,
                theme,
                localStorage: mockupStorage(reference, screen, state, theme),
              });
        const sheet = await composeSheet(browser, {
          title: `${screen} · ${state} · ${viewport} · ${theme}`,
          reference: mockup,
          app,
        });
        mkdirSync(join(outDir, 'shots'), { recursive: true });
        writeFileSync(join(outDir, `${name}.png`), sheet);
        writeFileSync(join(outDir, 'shots', `${name}-app.png`), app);
        if (mockup !== null) writeFileSync(join(outDir, 'shots', `${name}-mockup.png`), mockup);
      });
    }
  }
}
