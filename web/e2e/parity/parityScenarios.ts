import type { DemoWorld } from '../binsightServer';

// What the parity gate captures: each screen's states on the app, at the instant the demo is
// frozen at. The reference (the mockup) describes the same states its own way, in the parity.json
// next to it (see mockupReference.ts): the two sides share only the screen and state names.

export const PARITY_NOW = '2026-10-06T14:30:00Z';

export const VIEWPORT_NAMES = ['desktop', 'mobile'] as const;
export type ViewportName = (typeof VIEWPORT_NAMES)[number];
export const VIEWPORTS: Readonly<Record<ViewportName, { width: number; height: number }>> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export const THEMES = ['dark', 'light'] as const;
export type ThemeName = (typeof THEMES)[number];

// One interaction before the shot. A pointer position is a fraction of the element's box.
export type CaptureStep =
  | { readonly click: string }
  | { readonly hover: string }
  | { readonly press: string }
  | { readonly pointer: { readonly selector: string; readonly x: number; readonly y: number } }
  | { readonly scroll: number };

export interface CaptureScenario {
  // Path (and query or hash) under the side's base URL.
  readonly path: string;
  // Locators that must all be on the page before anything is captured: the positive sign that
  // the screen has its data and has drawn it. Never only the absence of a placeholder.
  readonly ready: readonly string[];
  readonly steps?: readonly CaptureStep[] | undefined;
  // The whole page instead of the first screen.
  readonly fullPage?: boolean | undefined;
  // Only on this viewport (both when absent).
  readonly viewport?: ViewportName | undefined;
  // The app side only: the demo world to capture on (nominal when absent; see DEMO_WORLDS).
  readonly world?: DemoWorld | undefined;
}

const CHART = 'figure svg[role="img"]';
// The overview has its figures, its chart is drawn and the live stream is connected.
const OVERVIEW_READY = [
  '[data-freshness] figure[data-ready="true"]',
  '[role="status"]:has-text("Live updates: Live")',
];

// The app side of every screen. A screen is added here when its parity gate opens.
export const APP_SCREENS: Readonly<Record<string, Readonly<Record<string, CaptureScenario>>>> = {
  overview: {
    header: { path: '/?period=3m', ready: OVERVIEW_READY },
    scrub: {
      path: '/?period=3m',
      ready: OVERVIEW_READY,
      steps: [{ pointer: { selector: CHART, x: 0.62, y: 0.5 } }],
    },
    full: { path: '/?period=3m', ready: OVERVIEW_READY, fullPage: true },
    'catching-up': { path: '/?period=3m', ready: OVERVIEW_READY, world: 'showcase' },
  },
};
