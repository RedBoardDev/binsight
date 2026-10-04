import { describe, expect, it } from 'vitest';
import { type DesignRuleName, findDesignViolations } from './styleRules';

const rulesBrokenBy = (path: string, text: string): DesignRuleName[] =>
  findDesignViolations([{ path, text }]).map((violation) => violation.rule);

describe('findDesignViolations', () => {
  it('accepts tokens, named sizes and onPress', () => {
    expect(
      rulesBrokenBy(
        'applications/Shared/Ui/Example.tsx',
        '<Button className="text-body text-muted bg-surface" onPress={go}>{t`Go`}</Button>',
      ),
    ).toEqual([]);
  });

  it('keeps colors in the palette file only', () => {
    expect(rulesBrokenBy('core/theme/midnight.css', '--background: #0b0f17;')).toEqual([]);
    expect(rulesBrokenBy('core/theme/base.css', 'color: #0b0f17;')).toEqual(['raw-color']);
    expect(rulesBrokenBy('core/Layout/Bar.tsx', "style={{ color: 'rgba(0, 0, 0, 0.5)' }}")).toEqual(
      ['raw-color'],
    );
    expect(rulesBrokenBy('core/Layout/Bar.tsx', '<use href="#solana-mark" />')).toEqual([]);
  });

  it('refuses Tailwind and arbitrary text sizes', () => {
    expect(rulesBrokenBy('core/Bar.tsx', 'className="text-sm"')).toEqual(['raw-text-size']);
    expect(rulesBrokenBy('core/Bar.tsx', 'className="text-[13px]"')).toEqual(['raw-text-size']);
    expect(rulesBrokenBy('core/Bar.tsx', 'className="text-small text-foreground"')).toEqual([]);
  });

  it('refuses dark variants and onClick', () => {
    expect(rulesBrokenBy('core/Bar.tsx', 'className="dark:bg-black"')).toEqual(['dark-variant']);
    expect(rulesBrokenBy('core/Bar.tsx', '<button onClick={go} />')).toEqual(['on-click']);
  });

  it('refuses float parsing everywhere but the plotting function', () => {
    expect(rulesBrokenBy('applications/Shared/Figure/Domain/x.ts', 'Number(amount)')).toEqual([
      'float-parsing',
    ]);
    expect(rulesBrokenBy('core/x.ts', 'parseFloat(value)')).toEqual(['float-parsing']);
    expect(rulesBrokenBy('core/x.ts', 'value.toFixed(2)')).toEqual(['float-parsing']);
    expect(rulesBrokenBy('core/x.ts', 'Number.isNaN(date.getTime())')).toEqual([]);
    expect(
      rulesBrokenBy('applications/Shared/Chart/Domain/plotValue.ts', 'Number(amount)'),
    ).toEqual([]);
  });

  it('refuses a JavaScript motion library', () => {
    expect(rulesBrokenBy('core/x.tsx', "import { animate } from 'motion';")).toEqual([
      'motion-library',
    ]);
    expect(rulesBrokenBy('core/x.tsx', "import { motion } from 'framer-motion';")).toEqual([
      'motion-library',
    ]);
  });

  it('names the file and the line of each violation', () => {
    expect(findDesignViolations([{ path: 'core/a.tsx', text: 'ok\nonClick' }])).toEqual([
      { rule: 'on-click', message: expect.stringMatching(/^core\/a\.tsx:2: /) },
    ]);
  });
});
