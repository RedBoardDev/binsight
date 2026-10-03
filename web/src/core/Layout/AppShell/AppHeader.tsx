import { LocaleSwitcher } from '@app/core/i18n/LocaleSwitcher';
import { ThemeSwitcher } from '@app/core/theme/ThemeSwitcher';

export const AppHeader = () => (
  <header className="flex h-16 shrink-0 items-center gap-3 border-border border-b bg-surface px-4">
    <span className="font-semibold text-accent text-lg md:hidden">binsight</span>
    <div className="ml-auto flex items-center gap-2">
      <LocaleSwitcher />
      <ThemeSwitcher />
    </div>
  </header>
);
