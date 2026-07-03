'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { AuthScreen } from '@/presentation/components/auth-screen';
import { SESSION_EXPIRED_PARAM } from '@/presentation/hooks/use-sign-out';
import { Button } from '@/presentation/ui';

const SESSION_EXPIRED_MESSAGE = 'Your session expired — please sign in again.';

/** Login = the Privy modal (email one-time code · Google · X). No SIWS, no passwords. */
function LoginScreen() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  const expired = useSearchParams().get(SESSION_EXPIRED_PARAM) === '1';

  useEffect(() => {
    if (ready && authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  return (
    <AuthScreen title="Binsight" subtitle="Sign in to your portfolio.">
      {expired && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-loss/30 bg-loss/10 px-3.5 py-2.5 text-loss text-xs"
        >
          {SESSION_EXPIRED_MESSAGE}
        </p>
      )}
      <Button onClick={() => login()} disabled={!ready || authenticated} className="w-full">
        {!ready ? 'Loading…' : authenticated ? 'Redirecting…' : 'Sign in'}
      </Button>
      <p className="mt-4 text-center text-faint text-xs">
        Email · Google · X — new accounts need an invite code.
      </p>
    </AuthScreen>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary for the build-time prerender.
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <LoginScreen />
    </Suspense>
  );
}
