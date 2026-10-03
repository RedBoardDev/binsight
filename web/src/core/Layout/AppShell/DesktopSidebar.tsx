import { AboutFooter } from '@app/core/Layout/AppShell/AboutFooter';
import { NAV_ITEMS } from '@app/core/Layout/AppShell/navItems';
import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';

export const DesktopSidebar = () => {
  const { i18n, t } = useLingui();

  return (
    <nav
      aria-label={t`Main navigation`}
      className="hidden w-60 shrink-0 flex-col gap-1 border-border border-r bg-surface p-3 md:flex"
    >
      <span className="px-3 py-3 font-semibold text-accent text-xl">binsight</span>
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          className="flex min-h-11 items-center gap-3 rounded-xl px-3 font-medium text-muted text-sm hover:bg-default data-[status=active]:bg-accent-soft data-[status=active]:text-accent-soft-foreground"
        >
          <Icon aria-hidden className="size-5" />
          {i18n._(label)}
        </Link>
      ))}
      <AboutFooter />
    </nav>
  );
};
