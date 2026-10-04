import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Link } from 'react-aria-components';

const ITEM_CLASS =
  'relative z-10 flex h-14 flex-1 flex-col items-center justify-center gap-1 rounded-full text-micro text-muted outline-none transition-colors duration-(--duration-quick) data-[current=true]:text-accent data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus';

interface TabBarContentProps {
  Icon: LucideIcon;
  label: string;
}

const TabBarContent = ({ Icon, label }: TabBarContentProps): ReactNode => (
  <>
    <Icon aria-hidden strokeWidth={1.75} className="size-5.5" />
    <span>{label}</span>
  </>
);

interface TabBarLinkProps extends TabBarContentProps {
  href: string;
  isCurrent: boolean;
  onPressCurrent: () => void;
}

export const TabBarLink = ({ href, isCurrent, onPressCurrent, Icon, label }: TabBarLinkProps) => (
  <Link
    href={href}
    aria-current={isCurrent ? 'page' : undefined}
    data-current={isCurrent}
    className={ITEM_CLASS}
    onPress={() => {
      if (isCurrent) {
        onPressCurrent();
      }
    }}
  >
    <TabBarContent Icon={Icon} label={label} />
  </Link>
);

interface TabBarButtonProps extends TabBarContentProps {
  isCurrent: boolean;
  onPress: () => void;
}

export const TabBarButton = ({ isCurrent, onPress, Icon, label }: TabBarButtonProps) => (
  <Button data-current={isCurrent} className={ITEM_CLASS} onPress={onPress}>
    <TabBarContent Icon={Icon} label={label} />
  </Button>
);
