import { Link } from '@heroui/react';

interface PositionQuickLinksProps {
  poolAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
}

/** Outbound links for the selected position — the pool on Meteora, the token on Solscan / GMGN. */
export const PositionQuickLinks = ({
  poolAddress,
  tokenMint,
  tokenSymbol,
}: PositionQuickLinksProps) => {
  const links: { label: string; href: string }[] = [];
  if (poolAddress) {
    links.push({ label: 'Meteora pool', href: `https://app.meteora.ag/dlmm/${poolAddress}` });
  }
  if (tokenMint) {
    links.push({
      label: `${tokenSymbol || 'Token'} · Solscan`,
      href: `https://solscan.io/token/${tokenMint}`,
    });
    links.push({
      label: `${tokenSymbol || 'Token'} · GMGN`,
      href: `https://gmgn.ai/sol/token/${tokenMint}`,
    });
  }
  if (links.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      {links.map((link) => (
        <Link.Root key={link.href} href={link.href} target="_blank" rel="noreferrer">
          {link.label}
          <Link.Icon />
        </Link.Root>
      ))}
    </div>
  );
};
