'use client';

import { authApi } from '@app/applications/Authentication/Api/auth.api';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { Alert, Button, FieldError, Form, Input, Label, Spinner, TextField } from '@heroui/react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

/** Backend minimum for a new password — mirrored here so the CTA stays disabled until it can succeed. */
const MIN_PASSWORD = 8;

/** Base64-encode raw signature bytes for transport to the backend (which base64-decodes + ed25519-verifies). */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

interface WalletProveFormProps {
  kind: 'register' | 'reset';
  onNotApproved: (address: string) => void;
}

/**
 * Connect a wallet, sign the backend's challenge, then set the password. This is the only proof of
 * wallet ownership the product has, so a password reset always comes through here.
 */
export const WalletProveForm = ({ kind, onNotApproved }: WalletProveFormProps) => {
  const router = useRouter();
  const { wallets, select, publicKey, connected, signMessage, disconnect } = useWallet();

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const passwordOk = password.length >= MIN_PASSWORD;
  const canSubmit = !busy && walletAddress !== null && passwordOk;

  const installable = wallets.filter(
    (w) =>
      w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  );

  const pickWallet = async (wallet: Wallet) => {
    setError(null);
    try {
      select(wallet.adapter.name);
      await wallet.adapter.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect the wallet.');
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!walletAddress || !canSubmit) return;
    if (!signMessage) {
      setError('This wallet cannot sign messages. Try Phantom or Solflare.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const challenge = await authApi.nonce(walletAddress, kind);
      if (!challenge.ok) {
        if (challenge.notWhitelisted) onNotApproved(walletAddress);
        else setError(challenge.error ?? 'Could not start — please retry.');
        return;
      }
      const signature = toBase64(await signMessage(new TextEncoder().encode(challenge.message)));
      const submit = kind === 'register' ? authApi.register : authApi.reset;
      const res = await submit({
        address: walletAddress,
        signature,
        nonce: challenge.nonce,
        password,
      });
      if (res.ok) router.replace('/');
      else setError(res.error ?? 'Could not complete — please retry.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signature cancelled.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      {walletAddress === null ? (
        <div className="flex flex-col gap-2">
          {installable.length === 0 ? (
            <p className="text-faint text-xs leading-relaxed">
              No Solana wallet detected. Install Phantom or Solflare, then refresh.
            </p>
          ) : (
            installable.map((wallet) => (
              <Button
                key={wallet.adapter.name}
                variant="secondary"
                size="lg"
                fullWidth
                className="justify-start"
                onPress={() => void pickWallet(wallet)}
              >
                {/* biome-ignore lint/performance/noImgElement: the icon is a data URI from the adapter. */}
                <img src={wallet.adapter.icon} alt="" width={20} height={20} className="size-5" />
                Connect {wallet.adapter.name}
              </Button>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-secondary py-1.5 pr-1.5 pl-3">
            <span className="tabular truncate text-foreground text-sm">
              {shortAddr(walletAddress, 6, 6)}
            </span>
            <Button variant="ghost" size="sm" onPress={() => void disconnect()}>
              Change
            </Button>
          </div>

          <TextField.Root
            type="password"
            value={password}
            onChange={setPassword}
            isInvalid={password.length > 0 && !passwordOk}
            name="password"
            className="flex flex-col gap-1.5"
          >
            <Label>{kind === 'reset' ? 'New password' : 'Password'}</Label>
            <Input
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD} characters`}
              className="h-11 text-base"
            />
            <FieldError>At least {MIN_PASSWORD} characters.</FieldError>
          </TextField.Root>

          <Button type="submit" variant="primary" size="lg" fullWidth isDisabled={!canSubmit}>
            {busy && <Spinner size="sm" color="current" />}
            {busy
              ? 'Verifying…'
              : kind === 'reset'
                ? 'Sign & set new password'
                : 'Sign & create account'}
          </Button>
        </>
      )}

      {error !== null && (
        <Alert.Root status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
    </Form>
  );
};
