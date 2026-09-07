'use client';

import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { useUi } from '@app/core/stores/uiStore';
import { Button, Card } from '@heroui/react';
import { Wallet } from 'lucide-react';

/** First-run state: no wallets watched yet → guide the user to add their first one (opens settings). */
export const EmptyWalletsState = () => {
  const { data, isPending, isError, refetch } = useWallets();
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);

  if (isPending) return null;

  // A FAILED /wallets fetch must show retry, not the onboarding, so a transient error never
  // masquerades as a brand-new, empty account.
  if (isError) {
    return (
      <Card.Root className="p-0">
        <Card.Content>
          <StateMessage
            hint="Check your connection and try again."
            onRetry={() => void refetch()}
            title="Couldn't load your wallets"
            variant="error"
          />
        </Card.Content>
      </Card.Root>
    );
  }

  if ((data?.length ?? 0) > 0) return null;

  return (
    <Card.Root className="px-6 py-12">
      <Card.Content className="flex flex-col items-center gap-5">
        <StateMessage
          className="p-0"
          hint="Add a Solana wallet to monitor its Meteora DLMM positions — live value, realized PnL and full on-chain history. The first add indexes its history once; after that it stays live."
          icon={<Wallet size={18} />}
          title="Track your first wallet"
        />
        <Button onPress={() => setSettingsOpen(true)} variant="primary">
          Add a wallet
        </Button>
      </Card.Content>
    </Card.Root>
  );
};
