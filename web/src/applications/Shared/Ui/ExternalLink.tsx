import { Link } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

interface ExternalLinkProps {
  href: string;
  children: ReactNode;
}

export const ExternalLink = ({ href, children }: ExternalLinkProps) => {
  const { t } = useLingui();

  return (
    <Link href={href} target="_blank" rel="noreferrer" className="gap-0.5">
      {children}
      <ArrowUpRight aria-hidden strokeWidth={1.75} className="size-3.5" />
      <span className="sr-only">{t`(opens in a new tab)`}</span>
    </Link>
  );
};
