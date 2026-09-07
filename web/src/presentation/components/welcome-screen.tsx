'use client';

import { shortAddr } from '@/domain/format';
import { Button } from '@/presentation/ui';
import { AuthScreen } from './auth-screen';

/**
 * The single first-login welcome screen (SPEC §1: "here is your wallet, here are the two spaces,
 * the bot is optional"). Shown once per account — the auth gate persists the seen-flag.
 */
export function WelcomeScreen({ address, onDone }: { address: string | null; onDone: () => void }) {
  return (
    <AuthScreen title="Welcome to Binsight" subtitle="Your account is ready — a quick tour.">
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-border bg-base px-3.5 py-3">
          <h2 className="mb-1 font-medium text-text text-xs">Your wallet</h2>
          <p className="text-muted text-xs">
            {address ? (
              <>
                A Solana wallet was created from your login:{' '}
                <span className="font-mono text-text">{shortAddr(address)}</span>. It is
                non-custodial — only you can recover or export it.
              </>
            ) : (
              'A Solana wallet is being created from your login. It is non-custodial — only you can recover or export it.'
            )}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-base px-3.5 py-3">
          <h2 className="mb-1 font-medium text-text text-xs">Two spaces</h2>
          <p className="text-muted text-xs">
            Tracking is your home: positions, PnL and history for your wallet plus wallets you
            follow. Copy-bot mirrors a leader wallet's DLMM activity with your own funds.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-base px-3.5 py-3">
          <h2 className="mb-1 font-medium text-text text-xs">The bot is optional</h2>
          <p className="text-muted text-xs">
            Binsight is fully useful without ever starting the bot — activate it only if and when
            you want to copy a leader.
          </p>
        </div>
        <Button onClick={onDone} className="mt-2 w-full">
          Got it
        </Button>
      </div>
    </AuthScreen>
  );
}
