import { TOP_BAR_PAGES } from '@app/core/Layout/AppShell/navItems';
import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';

export const DesktopNav = () => {
  const { i18n, t } = useLingui();

  return (
    <nav aria-label={t`Main`} className="hidden lg:block">
      <ul className="flex items-center gap-1">
        {TOP_BAR_PAGES.map(({ path, label, Icon }) => (
          <li key={path}>
            <Link
              to={path}
              activeOptions={{ exact: true }}
              className="group inline-flex h-9 items-center gap-2 rounded-lg px-3 font-medium text-meta text-muted transition-colors duration-(--duration-quick) hover:bg-hover hover:text-foreground active:bg-inset data-[status=active]:bg-inset data-[status=active]:text-foreground"
            >
              <Icon
                aria-hidden
                strokeWidth={1.75}
                className="size-4 group-data-[status=active]:text-accent"
              />
              {i18n._(label)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
};
