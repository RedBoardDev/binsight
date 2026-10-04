// The design rules a linter cannot check: every color comes from the palette file, every text size
// from the type scale, every amount stays a string, and motion stays in CSS. Each rule is a pattern
// searched line by line, with the files it does not apply to.

export interface StyledSource {
  readonly path: string;
  readonly text: string;
}

export interface DesignViolation {
  readonly rule: DesignRuleName;
  readonly message: string;
}

const DESIGN_RULE_NAMES = [
  'raw-color',
  'raw-text-size',
  'dark-variant',
  'on-click',
  'float-parsing',
  'motion-library',
] as const;

export type DesignRuleName = (typeof DESIGN_RULE_NAMES)[number];

interface DesignRule {
  readonly name: DesignRuleName;
  readonly pattern: RegExp;
  readonly appliesTo: (path: string) => boolean;
  readonly reason: string;
}

const PALETTE_FILE = 'core/theme/midnight.css';
const PLOT_VALUE_FILE = 'applications/Shared/Chart/Domain/plotValue.ts';
const CODE_FILE = /\.tsx?$/;
const STYLED_FILE = /\.(tsx?|css)$/;

const DESIGN_RULES: readonly DesignRule[] = [
  {
    name: 'raw-color',
    pattern: /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?)\(\s*\d/i,
    appliesTo: (path) => STYLED_FILE.test(path) && path !== PALETTE_FILE,
    reason: `colors live only in ${PALETTE_FILE}; use a theme token.`,
  },
  {
    name: 'raw-text-size',
    pattern: /\btext-(?:\[|(?:xs|sm|base|lg|xl|[2-9]xl)\b)/,
    appliesTo: (path) => CODE_FILE.test(path),
    reason: 'text sizes come from the named scale (text-hero … text-micro).',
  },
  {
    name: 'dark-variant',
    pattern: /\bdark:/,
    appliesTo: (path) => CODE_FILE.test(path),
    reason: 'the theme tokens already change with the theme; a dark: variant forks the palette.',
  },
  {
    name: 'on-click',
    pattern: /\bonClick\b/,
    appliesTo: (path) => CODE_FILE.test(path),
    reason: 'use onPress: it handles touch, keyboard and pointer alike.',
  },
  {
    name: 'float-parsing',
    pattern: /\bNumber\(|\bparseFloat\(|\.toFixed\(/,
    appliesTo: (path) => CODE_FILE.test(path) && path !== PLOT_VALUE_FILE,
    reason: `amounts stay decimal strings; only ${PLOT_VALUE_FILE} turns one into a number, to draw it.`,
  },
  {
    name: 'motion-library',
    pattern: /from\s+['"](?:motion|motion\/react|framer-motion)['"]/,
    appliesTo: (path) => CODE_FILE.test(path),
    reason: 'motion is CSS (motion.css) and HeroUI: one mechanism, one reduced-motion switch.',
  },
];

const findInSource = (source: StyledSource, rule: DesignRule): DesignViolation[] =>
  source.text
    .split('\n')
    .flatMap((line, index) =>
      rule.pattern.test(line)
        ? [{ rule: rule.name, message: `${source.path}:${index + 1}: ${rule.reason}` }]
        : [],
    );

export const findDesignViolations = (sources: readonly StyledSource[]): DesignViolation[] =>
  sources.flatMap((source) =>
    DESIGN_RULES.filter((rule) => rule.appliesTo(source.path)).flatMap((rule) =>
      findInSource(source, rule),
    ),
  );
