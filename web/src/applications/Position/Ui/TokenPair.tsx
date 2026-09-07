'use client';

import { strategyLabel } from '@app/applications/Position/Domain/positionLabels';
import type { StrategyFamily } from '@binsight/shared';
import { Chip, cn } from '@heroui/react';
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useState,
} from 'react';

/** Token logo URLs from the datapi are often slow/flaky sources (ipfs.io gateways, the archived
 *  solana-labs token-list on raw.githubusercontent). Route them through the wsrv.nl image proxy,
 *  which caches + resizes + re-encodes to webp, so they load fast and reliably (or fall back to the
 *  letter chip via onError). */
const iconUrl = (src: string): string =>
  `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=44&h=44&fit=cover&output=webp`;

interface TokenIconProps {
  src?: string;
  symbol: string;
}

const TokenIcon = ({ src, symbol }: TokenIconProps) => {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      // biome-ignore lint/performance/noImgElement: token icons load from arbitrary external CDNs (per token mint); next/image would need per-host remotePatterns config that isn't feasible for user-supplied tokens.
      <img
        src={iconUrl(src)}
        alt=""
        width={20}
        height={20}
        loading="lazy"
        onError={() => setFailed(true)}
        className="size-5 rounded-full bg-surface-tertiary object-cover ring-2 ring-surface"
      />
    );
  }
  return (
    <span className="grid size-5 place-items-center rounded-full bg-surface-tertiary font-semibold text-[9px] text-muted ring-2 ring-surface">
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
};

/** The row body is pressable (it opens the detail panel); these anchors sit inside it, so every
 *  activation path — pointer, click and Enter/Space — must stop before it reaches the row. */
const stopPointer = (event: PointerEvent) => event.stopPropagation();
const stopKey = (event: KeyboardEvent) => event.stopPropagation();
// Enter on a focused link fires a click with `detail === 0`, which react-aria reads as a virtual
// press on the row — so the click has to be stopped too, not just the pointer sequence.
const stopMouse = (event: MouseEvent) => event.stopPropagation();

interface FaviconLinkProps {
  href: string;
  src: string;
  label: string;
}

const FaviconLink = ({ href, src, label }: FaviconLinkProps) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    onPointerDown={stopPointer}
    onPointerUp={stopPointer}
    onClick={stopMouse}
    onKeyDown={stopKey}
    title={label}
    aria-label={label}
    className="grid size-7 place-items-center rounded-md opacity-80 transition-colors hover:bg-surface-tertiary hover:opacity-100"
  >
    {/* biome-ignore lint/performance/noImgElement: a tiny bundled brand favicon — next/image is unnecessary for a fixed 16px static asset. */}
    <img src={src} alt="" width={16} height={16} className="size-4 rounded-[3px]" />
  </a>
);

interface TokenPairProps {
  pair: string;
  iconX?: string;
  iconY?: string;
  strategy: StrategyFamily | null;
  /** When set, the hover-revealed Meteora / GMGN links are appended after the pair. */
  poolAddress?: string;
  tokenMint?: string;
  /** Extra hover-revealed actions (the closed-position share button) shown after the links. */
  actions?: ReactNode;
}

/** Overlapped token icons, the pair name and its strategy chip, followed by the pool links. The
 *  links use opacity (not display) so the row never reflows on hover, and `focus-within` reveals
 *  them for keyboard users. */
export const TokenPair = ({
  pair,
  iconX,
  iconY,
  strategy,
  poolAddress,
  tokenMint,
  actions,
}: TokenPairProps) => {
  const [symbolX = '', symbolY = ''] = pair.split('/');
  const strategyText = strategyLabel(strategy);
  const hasActions = poolAddress != null || tokenMint != null || actions != null;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="-space-x-1.5 flex shrink-0 items-center">
        <TokenIcon src={iconX} symbol={symbolX} />
        <TokenIcon src={iconY} symbol={symbolY} />
      </div>
      <span className="truncate font-medium text-foreground text-sm">{pair}</span>
      {strategyText && (
        <Chip.Root size="sm" variant="soft" color="default" className="shrink-0">
          <Chip.Label>{strategyText}</Chip.Label>
        </Chip.Root>
      )}
      {hasActions && (
        <div
          className={cn(
            '-my-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity',
            'focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          {poolAddress && (
            <FaviconLink
              href={`https://app.meteora.ag/dlmm/${poolAddress}`}
              src="/meteora.png"
              label="Open pool on Meteora"
            />
          )}
          {tokenMint && (
            <FaviconLink
              href={`https://gmgn.ai/sol/token/${tokenMint}`}
              src="/gmgn.png"
              label="Open token on GMGN"
            />
          )}
          {actions}
        </div>
      )}
    </div>
  );
};
