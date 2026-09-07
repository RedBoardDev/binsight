import { AccessPanel } from '@app/applications/Admin/Ui/AccessPanel';
import { AdminWalletsPanel } from '@app/applications/Admin/Ui/AdminWalletsPanel';
import { OwnerGate } from '@app/applications/Admin/Ui/OwnerGate';
import { Tabs } from '@heroui/react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminPage() {
  return (
    <OwnerGate>
      <main className="mx-auto w-full max-w-5xl px-5 py-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
        <header className="mb-6 flex items-center justify-between gap-3">
          <h1 className="font-display font-semibold text-foreground text-lg tracking-tight">
            Admin
          </h1>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/admin/rpc"
              className="inline-flex min-h-11 items-center text-muted transition-colors hover:text-foreground"
            >
              RPC credits
            </Link>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center text-muted transition-colors hover:text-foreground"
            >
              ← Dashboard
            </Link>
          </nav>
        </header>

        <Tabs.Root variant="primary" defaultSelectedKey="access">
          <Tabs.ListContainer>
            <Tabs.List>
              {/* RAC animates the indicator as a shared element BETWEEN tabs, so it has to live
                  inside each tab — as a sibling it throws at render. */}
              <Tabs.Tab id="access">
                Access
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="wallets">
                Wallets
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="access" className="mt-4">
            <AccessPanel />
          </Tabs.Panel>
          <Tabs.Panel id="wallets" className="mt-4">
            <AdminWalletsPanel />
          </Tabs.Panel>
        </Tabs.Root>
      </main>
    </OwnerGate>
  );
}
