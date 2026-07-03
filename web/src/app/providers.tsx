'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import { PRIVY_APP_ID } from '@/infrastructure/config';

/**
 * App-root client providers. Privy owns 100% of the session: login methods are email (one-time
 * code) + Google + X, and every login gets an embedded Solana wallet created on first login
 * (`createOnLogin: 'users-without-wallets'` — the account's bot/trading wallet, per SPEC §1).
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  // Fail loud, not blank: a build without the app id can never authenticate anyone.
  if (!PRIVY_APP_ID) {
    return (
      <main className="grid min-h-dvh place-items-center px-6">
        <p role="alert" className="max-w-sm text-center text-muted text-sm">
          Configuration error: <span className="font-mono">NEXT_PUBLIC_PRIVY_APP_ID</span> is not
          set — authentication is unavailable.
        </p>
      </main>
    );
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'google', 'twitter'],
        embeddedWallets: {
          solana: {
            createOnLogin: 'users-without-wallets',
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
