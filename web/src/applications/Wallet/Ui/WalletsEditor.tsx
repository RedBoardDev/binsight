'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { isSolanaAddress } from '@app/applications/Shared/Domain/solanaAddress';
import { useWalletMutations, useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { WalletRow } from '@app/applications/Wallet/Ui/WalletsEditor/WalletRow';
import { Alert, Button, FieldError, Form, Input, Label, Skeleton, TextField } from '@heroui/react';
import { type FormEvent, useState } from 'react';

/** The watchlist editor: the watched wallets plus the add form. */
export const WalletsEditor = () => {
  const { data, isPending } = useWallets();
  const { add, remove } = useWalletMutations();
  const scope = usePortfolioFeed((s) => s.scope);
  const setScope = usePortfolioFeed((s) => s.setScope);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wallets = data ?? [];
  const trimmed = address.trim();
  const valid = isSolanaAddress(trimmed);
  const duplicate = wallets.some((wallet) => wallet.address === trimmed);
  const invalid = trimmed.length > 0 && (!valid || duplicate);

  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || duplicate) return;
    setError(null);
    // apiSend resolves `false` on a non-2xx instead of throwing, so the result has to be checked.
    const ok = await add.mutateAsync({ address: trimmed, label: label.trim() }).catch(() => false);
    if (!ok) {
      setError('Could not add wallet.');
      return;
    }
    setAddress('');
    setLabel('');
  };

  const onRemove = async (removed: string) => {
    setError(null);
    const ok = await remove.mutateAsync(removed).catch(() => false);
    if (!ok) {
      setError('Could not remove wallet.');
      return;
    }
    // The feed would keep polling a wallet that is no longer watched — fall back to the aggregate.
    if (scope === removed) setScope('all');
  };

  return (
    <div className="flex flex-col gap-4">
      {isPending ? (
        <div className="flex flex-col gap-1">
          <Skeleton.Root className="h-12 w-full rounded-lg" />
          <Skeleton.Root className="h-12 w-full rounded-lg" />
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {wallets.length === 0 && <li className="text-faint text-sm">No wallets yet.</li>}
          {wallets.map((wallet) => (
            <WalletRow
              key={wallet.address}
              onRemove={(removed) => void onRemove(removed)}
              wallet={wallet}
            />
          ))}
        </ul>
      )}

      <Form.Root className="flex flex-col gap-3 border-separator border-t pt-4" onSubmit={onAdd}>
        <TextField.Root
          className="flex flex-col gap-1.5"
          isInvalid={invalid}
          onChange={setAddress}
          value={address}
        >
          <Label>Wallet address</Label>
          <Input
            autoComplete="off"
            className="tabular text-base"
            placeholder="Solana address"
            spellCheck={false}
          />
          <FieldError>{duplicate ? 'Already watched.' : 'Not a valid Solana address.'}</FieldError>
        </TextField.Root>
        <TextField.Root className="flex flex-col gap-1.5" onChange={setLabel} value={label}>
          <Label>Label (optional)</Label>
          <Input className="text-base" placeholder="Main wallet" />
        </TextField.Root>
        {error && (
          <Alert.Root status="danger">
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        <Button
          className="self-start"
          isDisabled={add.isPending || !valid || duplicate}
          type="submit"
          variant="primary"
        >
          {add.isPending ? 'Adding…' : 'Add wallet'}
        </Button>
      </Form.Root>
    </div>
  );
};
