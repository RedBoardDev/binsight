import { SignOutButton } from '@app/applications/Auth/Ui/SignOutButton';
import { RealtimeStatusIndicator } from '@app/applications/Realtime/Ui/RealtimeStatusIndicator';
import { LocaleSwitcher } from '@app/core/i18n/LocaleSwitcher';
import { ThemeSwitcher } from '@app/core/theme/ThemeSwitcher';

// Wraps onto a second row on narrow screens rather than pushing its last buttons off-screen.
export const AppHeader = () => (
  <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-border border-b bg-surface px-4 py-2">
    <span className="text-accent text-section md:hidden">binsight</span>
    <RealtimeStatusIndicator />
    <div className="ml-auto flex items-center gap-2">
      <LocaleSwitcher />
      <ThemeSwitcher />
      <SignOutButton />
    </div>
  </header>
);
