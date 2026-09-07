'use client';

import { AuthGate } from '@/presentation/components/auth-gate';
import { Dashboard } from '@/presentation/components/dashboard';

// Auth state is 100% Privy and lives client-side — the dashboard is a client-gated shell
// (no SSR session cookie to check anymore).
export default function Home() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
