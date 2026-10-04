import { describe, expect, it } from 'vitest';
import { findPlacementViolations } from './placementRules';
import type { Rule } from './violation';

const rulesBrokenBy = (paths: readonly string[]): Rule[] =>
  findPlacementViolations(paths).map((violation) => violation.rule);

describe('findPlacementViolations', () => {
  it('accepts the reference layout', () => {
    expect(
      rulesBrokenBy([
        'main.tsx',
        'routes/__root.tsx',
        'routes/_authenticated/index.tsx',
        'core/Layout/AppShell.tsx',
        'core/Layout/AppShell/MobileTabBar.tsx',
        'applications/Auth/Api/useSessionCheck.api.ts',
        'applications/Auth/Api/sessionGuards.ts',
        'applications/Auth/Domain/safeRedirect.ts',
        'applications/Auth/Domain/safeRedirect.spec.ts',
        'applications/Auth/Ui/LoginForm.tsx',
        'applications/Auth/Ui/LoginForm/PasswordField.tsx',
        'applications/Shared/Ui/toast.ts',
        'applications/Shared/Charts/Ui/PriceChart.tsx',
        'locales/fr/messages.po',
      ]),
    ).toEqual([]);
  });

  it('rejects catch-all file and folder names', () => {
    expect(rulesBrokenBy(['applications/Auth/Domain/utils.ts'])).toEqual(['forbidden-name']);
    expect(rulesBrokenBy(['core/types.ts'])).toEqual(['forbidden-name']);
    expect(rulesBrokenBy(['lib/helpers/format.ts'])).toEqual(['forbidden-name']);
    expect(rulesBrokenBy(['core/__tests__/theme.spec.ts'])).toContain('forbidden-name');
  });

  it('rejects index files outside routes/', () => {
    expect(rulesBrokenBy(['core/i18n/index.ts'])).toEqual(['forbidden-name']);
    expect(rulesBrokenBy(['routes/index.tsx'])).toEqual([]);
  });

  it('rejects a module that is not PascalCase or holds more than its three layers', () => {
    expect(rulesBrokenBy(['applications/wallets/Ui/WalletList.tsx'])).toEqual(['module-shape']);
    expect(rulesBrokenBy(['applications/Wallet/components/WalletList.tsx'])).toEqual([
      'module-shape',
    ]);
    expect(rulesBrokenBy(['applications/Wallet/walletList.ts'])).toEqual(['module-shape']);
    expect(rulesBrokenBy(['applications/walletList.ts'])).toEqual(['module-shape']);
    expect(rulesBrokenBy(['applications/Wallet/Sub/Ui/WalletList.tsx'])).toEqual(['module-shape']);
  });

  it('rejects a spec without a file of the same base name next to it', () => {
    expect(rulesBrokenBy(['core/theme/themePreference.spec.ts'])).toEqual(['spec-next-to-subject']);
    expect(
      rulesBrokenBy(['core/theme/ThemeSwitcher.tsx', 'core/theme/ThemeSwitcher.spec.tsx']),
    ).toEqual([]);
  });
});
