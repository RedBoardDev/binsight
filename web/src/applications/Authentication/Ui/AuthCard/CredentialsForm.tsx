'use client';

import { authApi } from '@app/applications/Authentication/Api/auth.api';
import { useResetSession } from '@app/applications/Authentication/Api/useSession.api';
import { isSolanaAddress } from '@app/applications/Shared/Domain/solanaAddress';
import { Alert, Button, FieldError, Form, Input, Label, Spinner, TextField } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

/** Backend minimum for a new password — mirrored here so the CTA stays disabled until it can succeed. */
const MIN_PASSWORD = 8;

interface CredentialsFormProps {
  mode: 'signin' | 'signup';
  /** The backend wants a wallet signature for this sign-up (the owner address in open access). */
  onSignatureRequired?: () => void;
}

/** Address + password, no signature: sign-in always, and sign-up when the backend runs open-access. */
export const CredentialsForm = ({ mode, onSignatureRequired }: CredentialsFormProps) => {
  const router = useRouter();
  const resetSession = useResetSession();
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignin = mode === 'signin';
  const trimmed = address.trim();
  const addressOk = isSolanaAddress(trimmed);
  const passwordOk = isSignin ? password.length > 0 : password.length >= MIN_PASSWORD;
  const canSubmit = !busy && addressOk && passwordOk;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = isSignin
        ? await authApi.login(trimmed, password)
        : await authApi.register({ address: trimmed, password });
      if (res.ok) {
        resetSession();
        router.replace('/');
        return;
      }
      if (!isSignin && res.signatureRequired && onSignatureRequired) {
        onSignatureRequired();
        return;
      }
      setError(
        res.error ?? (isSignin ? 'Invalid address or password.' : 'Could not create the account.'),
      );
    } catch {
      setError('Could not reach the server — please retry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <TextField.Root
        value={address}
        onChange={setAddress}
        isInvalid={address.length > 0 && !addressOk}
        autoComplete="username"
        name="address"
        className="flex flex-col gap-1.5"
      >
        <Label>Wallet address</Label>
        <Input
          placeholder="Your Solana address"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="tabular h-11 text-base"
        />
        <FieldError>That doesn’t look like a Solana address.</FieldError>
      </TextField.Root>

      <TextField.Root
        type="password"
        value={password}
        onChange={setPassword}
        isInvalid={!isSignin && password.length > 0 && !passwordOk}
        name="password"
        className="flex flex-col gap-1.5"
      >
        <Label>Password</Label>
        <Input
          autoComplete={isSignin ? 'current-password' : 'new-password'}
          placeholder={isSignin ? 'Your password' : `At least ${MIN_PASSWORD} characters`}
          className="h-11 text-base"
        />
        <FieldError>At least {MIN_PASSWORD} characters.</FieldError>
      </TextField.Root>

      {error !== null && (
        <Alert.Root status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Button type="submit" variant="primary" size="lg" fullWidth isDisabled={!canSubmit}>
        {busy && <Spinner size="sm" color="current" />}
        {busy
          ? isSignin
            ? 'Signing in…'
            : 'Creating account…'
          : isSignin
            ? 'Sign in'
            : 'Create account'}
      </Button>
    </Form>
  );
};
