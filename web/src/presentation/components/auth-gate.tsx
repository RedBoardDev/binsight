'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { authApi, setAuthFailureHandler } from '@/infrastructure/api/client';
import { LOGIN_ROUTE, useSignOut } from '@/presentation/hooks/use-sign-out';
import { Button } from '@/presentation/ui';
import { AuthScreen } from './auth-screen';
import { InviteGate } from './invite-gate';
import { WelcomeScreen } from './welcome-screen';

/**
 * The single client-side auth gate wrapping the app. Privy auth state only exists in the browser,
 * so the flow is sequenced here: Privy not ready → loading shell · not authenticated → login page ·
 * authenticated without an account → invite gate · first visit → welcome screen · else the app.
 * It also owns the centralized auth-failure handling of the API client (session expiry → login
 * with a visible message; 403 needsInvite → back to the invite gate).
 */

type GateState =
  | { phase: 'checking' }
  | { phase: 'error' }
  | { phase: 'needsInvite' }
  | { phase: 'registered'; address: string | null; isOwner: boolean };

// Welcome seen-flag: non-sensitive, per account (keyed by the Privy user id — the DID is the
// account identity, stable across devices' /auth/me shapes), persisted in localStorage.
const WELCOME_SEEN_KEY_PREFIX = 'binsight.welcomeSeen.';

function hasSeenWelcome(accountKey: string): boolean {
  try {
    return localStorage.getItem(WELCOME_SEEN_KEY_PREFIX + accountKey) === '1';
  } catch {
    return false;
  }
}

function markWelcomeSeen(accountKey: string): void {
  try {
    localStorage.setItem(WELCOME_SEEN_KEY_PREFIX + accountKey, '1');
  } catch {
    // Storage unavailable (private mode): the welcome shows again next login — harmless.
  }
}

/** Blank full-height shell shown while auth state resolves (matches the pre-mount dashboard). */
function LoadingShell() {
  return <div className="min-h-dvh" aria-busy="true" />;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, authenticated, user } = usePrivy();
  const router = useRouter();
  const signOut = useSignOut();
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  // Guards the expired-session sign-out: fire it once (a burst of 401s must not queue logouts)
  // and let it own the redirect (the plain !authenticated redirect below would drop the message).
  const expiringRef = useRef(false);

  const loadMe = useCallback(async () => {
    setState({ phase: 'checking' });
    try {
      const me = await authApi.me();
      setState(
        me.registered
          ? { phase: 'registered', address: me.address, isOwner: me.isOwner }
          : { phase: 'needsInvite' },
      );
    } catch {
      // Fail loud with a retry — never an infinite skeleton or a fake-empty state (SPEC UX #81/#83).
      setState({ phase: 'error' });
    }
  }, []);

  // Centralized API auth failures: any 401 = the Privy session is dead; any 403 needsInvite = the
  // account disappeared under us (e.g. revoked) — re-run the gate rather than freezing data views.
  useEffect(() => {
    setAuthFailureHandler((kind) => {
      if (kind === 'expired') {
        if (expiringRef.current) return;
        expiringRef.current = true;
        void signOut({ expired: true });
      } else {
        setState({ phase: 'needsInvite' });
      }
    });
    return () => setAuthFailureHandler(null);
  }, [signOut]);

  useEffect(() => {
    if (ready && !authenticated && !expiringRef.current) router.replace(LOGIN_ROUTE);
  }, [ready, authenticated, router]);

  useEffect(() => {
    if (ready && authenticated) void loadMe();
  }, [ready, authenticated, loadMe]);

  if (!ready || !authenticated || state.phase === 'checking') return <LoadingShell />;

  if (state.phase === 'error') {
    return (
      <AuthScreen title="Binsight" subtitle="Could not load your account.">
        <p className="mb-4 text-center text-muted text-xs">
          The server did not answer — check your connection and retry.
        </p>
        <Button onClick={() => void loadMe()} className="w-full">
          Retry
        </Button>
      </AuthScreen>
    );
  }

  if (state.phase === 'needsInvite') return <InviteGate onRegistered={loadMe} />;

  const accountKey = user?.id ?? null;
  if (accountKey && !welcomeDismissed && !hasSeenWelcome(accountKey)) {
    return (
      <WelcomeScreen
        address={state.address}
        onDone={() => {
          markWelcomeSeen(accountKey);
          setWelcomeDismissed(true);
        }}
      />
    );
  }

  return <>{children}</>;
}
