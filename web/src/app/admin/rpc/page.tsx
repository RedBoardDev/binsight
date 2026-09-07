import { OwnerGate } from '@app/applications/Admin/Ui/OwnerGate';
import { RpcTelemetryPanel } from '@app/applications/Admin/Ui/RpcTelemetryPanel';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'RPC credits' };

export default function RpcCreditsPage() {
  return (
    <OwnerGate>
      <main className="mx-auto w-full max-w-5xl px-5 py-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
        <header className="mb-6 flex items-center justify-between gap-3">
          <h1 className="font-display font-semibold text-foreground text-lg tracking-tight">
            RPC credits
          </h1>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/admin"
              className="inline-flex min-h-11 items-center text-muted transition-colors hover:text-foreground"
            >
              Admin
            </Link>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center text-muted transition-colors hover:text-foreground"
            >
              ← Dashboard
            </Link>
          </nav>
        </header>

        <RpcTelemetryPanel />
      </main>
    </OwnerGate>
  );
}
