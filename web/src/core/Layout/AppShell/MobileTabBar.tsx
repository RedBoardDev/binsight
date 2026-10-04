import { NAV_ITEMS } from '@app/core/Layout/AppShell/navItems';
import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';

export const MobileTabBar = () => {
  const { i18n, t } = useLingui();

  return (
    <nav
      aria-label={t`Main navigation`}
      className="flex shrink-0 border-border border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 font-medium text-muted text-small data-[status=active]:text-accent"
        >
          <Icon aria-hidden className="size-5" />
          {i18n._(label)}
        </Link>
      ))}
    </nav>
  );
};
