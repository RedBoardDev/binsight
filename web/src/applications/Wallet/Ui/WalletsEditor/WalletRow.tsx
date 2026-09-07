'use client';

import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { useCopy } from '@app/applications/Shared/Ui/useCopy';
import type { Wallet } from '@binsight/shared';
import { AlertDialog, Button } from '@heroui/react';
import { Check, Copy } from 'lucide-react';

interface WalletRowProps {
  wallet: Wallet;
  onRemove: (address: string) => void;
}

/** One watched wallet: label + address, copy, and a confirmed remove — one stray click must not
 *  drop a watched wallet. */
export const WalletRow = ({ wallet, onRemove }: WalletRowProps) => {
  const { copied, copy } = useCopy();
  const short = shortAddr(wallet.address, 6, 6);

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg bg-surface-secondary px-3 py-2">
      <div className="flex min-w-0 flex-col">
        {wallet.label && (
          <span className="truncate font-medium text-foreground text-sm">{wallet.label}</span>
        )}
        <span className="tabular text-faint text-xs">{short}</span>
        {wallet.ready === false && <span className="text-accent text-xs">indexing…</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          aria-label="Copy address"
          // 44px on a phone (HeroUI's own md button is 40) — this row also lives in the mobile drawer.
          className="size-11 md:size-9"
          isIconOnly
          onPress={() => void copy(wallet.address)}
          variant="ghost"
        >
          {copied ? <Check className="text-success" size={15} /> : <Copy size={15} />}
        </Button>
        <AlertDialog.Root>
          <Button className="h-11 md:h-9" variant="danger-soft">
            Remove
          </Button>
          <AlertDialog.Backdrop>
            <AlertDialog.Container size="sm">
              <AlertDialog.Dialog>
                {({ close }) => (
                  <>
                    <AlertDialog.Header>
                      <AlertDialog.Icon status="danger" />
                      <AlertDialog.Heading>Stop watching this wallet?</AlertDialog.Heading>
                    </AlertDialog.Header>
                    <AlertDialog.Body>
                      <p className="text-muted text-sm">
                        <span className="tabular text-foreground">{short}</span> drops out of your
                        positions, history and scope selector. You can add it back at any time.
                      </p>
                    </AlertDialog.Body>
                    <AlertDialog.Footer>
                      <Button onPress={close} variant="secondary">
                        Cancel
                      </Button>
                      <Button
                        onPress={() => {
                          close();
                          onRemove(wallet.address);
                        }}
                        variant="danger"
                      >
                        Remove wallet
                      </Button>
                    </AlertDialog.Footer>
                  </>
                )}
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog.Root>
      </div>
    </li>
  );
};
