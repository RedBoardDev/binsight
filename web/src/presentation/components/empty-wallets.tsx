'use client';

import { useUi } from '@/application/stores/ui-store';
import { useWallets } from '@/application/stores/wallets-store';
import { Button, Card, EmptyState } from '@/presentation/ui';

/** First-run state: no wallets watched yet → guide the user to add their first one (opens settings). */
export function EmptyWallets() {
  const loaded = useWallets((s) => s.loaded);
  const count = useWallets((s) => s.wallets.length);
  const error = useWallets((s) => s.error);
  const refresh = useWallets((s) => s.refresh);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  if (!loaded || count > 0) return null;

  // A failed first /wallets fetch also lands here (loaded + zero wallets) — show retry, not the
  // onboarding, so a transient error never masquerades as a brand-new, empty account.
  if (error) {
    return (
      <Card className="px-6 py-14">
        <EmptyState
          variant="error"
          title="Couldn't load your wallets"
          hint="Check your connection and try again."
          onRetry={() => void refresh()}
        />
      </Card>
    );
  }

  return (
    <Card className="flex flex-col items-center gap-4 px-6 py-14 text-center">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-semibold text-lg text-text">Track your first wallet</h2>
        <p className="mx-auto max-w-md text-muted text-sm">
          Add a Solana wallet to monitor its Meteora DLMM positions — live value, realized PnL and
          full on-chain history. The first add indexes its history once; after that it stays live.
        </p>
      </div>
      <Button onClick={() => setSettingsOpen(true)}>Add a wallet</Button>
    </Card>
  );
}
