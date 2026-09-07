'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import {
  usePositionBins,
  usePositionHistory,
} from '@app/applications/Position/Api/usePositions.api';
import { BinHistogram } from '@app/applications/Position/Ui/BinHistogram';
import { ClosedPositionSummary } from '@app/applications/Position/Ui/PositionDetailPanel/ClosedPositionSummary';
import { OpenPositionSummary } from '@app/applications/Position/Ui/PositionDetailPanel/OpenPositionSummary';
import { PositionQuickLinks } from '@app/applications/Position/Ui/PositionDetailPanel/PositionQuickLinks';
import { PositionEventTimeline } from '@app/applications/Position/Ui/PositionEventTimeline';
import { SharePnlCardButton } from '@app/applications/Position/Ui/SharePnlCardButton';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { useCopy } from '@app/applications/Shared/Ui/useCopy';
import { useIsMobile } from '@app/applications/Shared/Ui/useIsMobile';
import { type SelectedPosition, useUi } from '@app/core/stores/uiStore';
import { Button, Drawer, Link, Skeleton, Tooltip } from '@heroui/react';
import { Check, Copy } from 'lucide-react';

type Selected = NonNullable<SelectedPosition>;

interface CopyAddressButtonProps {
  address: string;
}

const CopyAddressButton = ({ address }: CopyAddressButtonProps) => {
  const { copied, copy } = useCopy();
  return (
    <Tooltip.Root>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Copy address"
        onPress={() => void copy(address)}
      >
        {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
      </Button>
      <Tooltip.Content>{copied ? 'Copied' : 'Copy address'}</Tooltip.Content>
    </Tooltip.Root>
  );
};

interface PositionDetailBodyProps {
  selected: Selected;
}

const PositionDetailBody = ({ selected }: PositionDetailBodyProps) => {
  const [symbolX = '', symbolY = ''] = selected.pair.split('/');
  const entity = usePortfolioFeed((s) =>
    selected.open
      ? (s.portfolio?.open.find((position) => position.address === selected.address) ?? null)
      : null,
  );
  // Only open positions have live on-chain liquidity — skip the bins fetch (404) for closed ones.
  const bins = usePositionBins(selected.address, selected.open);
  const history = usePositionHistory(selected.address);

  const poolAddress = entity?.raw.poolAddress ?? selected.closed?.poolAddress;
  const tokenMint = entity?.raw.tokenXMint ?? selected.closed?.tokenXMint;

  return (
    <div className="flex flex-col gap-7 pb-2">
      {entity && <OpenPositionSummary position={entity} />}
      {selected.closed && <ClosedPositionSummary position={selected.closed} />}

      <PositionQuickLinks poolAddress={poolAddress} tokenMint={tokenMint} tokenSymbol={symbolX} />

      {selected.open && (
        <section className="flex flex-col gap-3">
          <SectionLabel>Liquidity by price</SectionLabel>
          {bins.isPending ? (
            <Skeleton.Root className="h-36 w-full" />
          ) : bins.isError ? (
            <StateMessage
              variant="error"
              title="Couldn't load liquidity"
              hint="The bin snapshot did not answer."
              onRetry={() => void bins.refetch()}
            />
          ) : bins.data ? (
            <BinHistogram data={bins.data} />
          ) : (
            <StateMessage title="No live liquidity" />
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <SectionLabel>History</SectionLabel>
        {history.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton.Root className="h-5 w-full" />
            <Skeleton.Root className="h-5 w-3/4" />
            <Skeleton.Root className="h-5 w-2/3" />
          </div>
        ) : history.isError ? (
          <StateMessage
            variant="error"
            title="Couldn't load history"
            hint="The on-chain timeline did not answer."
            onRetry={() => void history.refetch()}
          />
        ) : history.data && history.data.events.length > 0 ? (
          <PositionEventTimeline events={history.data.events} symbolX={symbolX} symbolY={symbolY} />
        ) : (
          <StateMessage title="No on-chain history" />
        )}
      </section>
    </div>
  );
};

/** The position detail overlay: a right-side drawer on desktop, a bottom sheet on phones. Same
 *  content either way — only the chrome changes. */
export const PositionDetailPanel = () => {
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);
  const isMobile = useIsMobile();

  return (
    <Drawer.Root isOpen={selected != null} onOpenChange={(isOpen) => !isOpen && select(null)}>
      <Drawer.Backdrop variant="opaque">
        <Drawer.Content placement={isMobile ? 'bottom' : 'right'}>
          <Drawer.Dialog className={isMobile ? undefined : 'w-[min(34rem,92vw)]'}>
            {isMobile && <Drawer.Handle />}
            {selected && (
              <>
                <Drawer.Header className="flex-row flex-wrap items-center gap-2">
                  <Drawer.Heading className="truncate">{selected.pair}</Drawer.Heading>
                  <Link.Root
                    href={`https://solscan.io/account/${selected.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tabular text-xs"
                  >
                    {shortAddr(selected.address)}
                    <Link.Icon />
                  </Link.Root>
                  <CopyAddressButton address={selected.address} />
                  {/* Closed positions can be exported as the PnL share-card PNG. */}
                  {selected.closed && <SharePnlCardButton position={selected.closed} />}
                  <Drawer.CloseTrigger className="ml-auto" />
                </Drawer.Header>
                <Drawer.Body>
                  <PositionDetailBody key={selected.address} selected={selected} />
                </Drawer.Body>
              </>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  );
};
