'use client';

import { WalletProviders } from '@app/applications/Authentication/Ui/WalletProviders';
import { Button, Card } from '@heroui/react';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { CredentialsForm } from './AuthCard/CredentialsForm';
import { NotApprovedNotice } from './AuthCard/NotApprovedNotice';
import { WalletProveForm } from './AuthCard/WalletProveForm';

type AuthMode = 'signin' | 'signup' | 'reset';

const TITLE: Record<AuthMode, string> = {
  signin: 'Sign in',
  signup: 'Create account',
  reset: 'Reset password',
};

const subtitleOf = (mode: AuthMode, openAccess: boolean): string => {
  if (mode === 'signin') return 'Sign in to your portfolio.';
  if (mode === 'reset') return 'Reset your password with your wallet.';
  return openAccess
    ? 'Create an account to follow a wallet.'
    : 'Connect your wallet to create an account.';
};

interface AuthCardProps {
  openAccess: boolean;
}

/** The whole signed-out surface: sign in, create an account, reset a password. Carries its own
 *  wallet context so the adapters never ship with the dashboard bundle. */
export const AuthCard = ({ openAccess }: AuthCardProps) => {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [notApproved, setNotApproved] = useState<string | null>(null);
  // Open access still asks the OWNER address for a signature: owner rights are never granted to a
  // password alone.
  const [signatureRequired, setSignatureRequired] = useState(false);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setNotApproved(null);
    setSignatureRequired(false);
  };

  // Open-access signup reuses the address + password form (no wallet signature). Reset always needs a
  // signature (the only ownership proof), so it keeps the connect-and-sign flow in either mode.
  const credentialsForm =
    mode === 'signin' || (mode === 'signup' && openAccess && !signatureRequired);

  return (
    <WalletProviders>
      <main className="grid min-h-dvh place-items-center px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm animate-rise">
          <div className="mb-7 flex flex-col items-center gap-3">
            {/* biome-ignore lint/performance/noImgElement: a fixed static brand mark, no layout cost. */}
            <img src="/icon.svg" alt="" width={52} height={52} className="size-13" />
            <span className="font-display font-semibold text-foreground text-xl tracking-tight">
              Binsight
            </span>
          </div>

          <Card.Root>
            <Card.Header className="flex flex-col gap-1">
              <Card.Title>{TITLE[mode]}</Card.Title>
              <Card.Description>{subtitleOf(mode, openAccess)}</Card.Description>
            </Card.Header>

            <Card.Content>
              {notApproved !== null ? (
                <NotApprovedNotice address={notApproved} onBack={() => switchMode('signin')} />
              ) : credentialsForm ? (
                <CredentialsForm
                  key={mode}
                  mode={mode === 'signin' ? 'signin' : 'signup'}
                  onSignatureRequired={() => setSignatureRequired(true)}
                />
              ) : (
                <WalletProveForm
                  key={mode}
                  kind={mode === 'signup' ? 'register' : 'reset'}
                  onNotApproved={setNotApproved}
                />
              )}
            </Card.Content>

            {notApproved === null && (
              <Card.Footer className="flex flex-col items-stretch gap-1 border-separator border-t pt-4">
                {mode === 'signin' ? (
                  <>
                    <Button variant="ghost" size="sm" onPress={() => switchMode('signup')}>
                      {openAccess
                        ? 'No account? Create one'
                        : 'No account? Create one with your wallet'}
                    </Button>
                    <Button variant="ghost" size="sm" onPress={() => switchMode('reset')}>
                      Forgot password?
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onPress={() => switchMode('signin')}>
                    <ArrowLeft size={14} />
                    Back to sign in
                  </Button>
                )}
              </Card.Footer>
            )}
          </Card.Root>
        </div>
      </main>
    </WalletProviders>
  );
};
