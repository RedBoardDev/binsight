'use client';

import { useIdentity } from '@app/applications/Authentication/Api/useIdentity.api';
import { useSignOut } from '@app/applications/Authentication/Api/useSession.api';
import { PushNotificationsSection } from '@app/applications/Settings/Ui/PushNotificationsSection';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { WalletsEditor } from '@app/applications/Wallet/Ui/WalletsEditor';
import { useOpenAccess } from '@app/core/Layout/OpenAccessContext';
import { useUi } from '@app/core/stores/uiStore';
import { Button, Drawer, Separator, useOverlayState } from '@heroui/react';
import { ArrowRight, LogOut } from 'lucide-react';
import Link from 'next/link';

/** The settings drawer: watchlist, notifications, the owner-only admin entry and sign-out. */
export const SettingsPanel = () => {
  const settingsOpen = useUi((s) => s.settingsOpen);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const openAccess = useOpenAccess();
  const { data: identity } = useIdentity();
  const signOut = useSignOut();
  const state = useOverlayState({ isOpen: settingsOpen, onOpenChange: setSettingsOpen });

  return (
    <Drawer.Root state={state}>
      <Drawer.Backdrop variant="opaque">
        <Drawer.Content placement="right">
          {/* HeroUI sizes a side drawer to 85% of the viewport, which leaves a useless sliver of
              dashboard on a phone. Full width below `sm`, a fixed panel above it. */}
          <Drawer.Dialog className="w-full max-w-none sm:w-[28rem] sm:max-w-[28rem]">
            <Drawer.Header>
              <Drawer.Heading>{openAccess ? 'Account' : 'Wallets'}</Drawer.Heading>
              <Drawer.CloseTrigger />
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-6">
              {/* Open-access accounts are single-wallet with notifications disabled — hide both. */}
              {!openAccess && (
                <>
                  <section className="flex flex-col gap-3">
                    <SectionLabel>Watchlist</SectionLabel>
                    <WalletsEditor />
                  </section>
                  <Separator />
                  <PushNotificationsSection />
                </>
              )}
              {identity?.isOwner && (
                <>
                  <Separator />
                  <section className="flex flex-col gap-3">
                    <SectionLabel>Admin</SectionLabel>
                    <Link
                      className="flex min-h-11 items-center justify-between rounded-xl border border-border bg-background px-3.5 py-3 text-foreground text-sm transition-colors hover:bg-surface-secondary"
                      href="/admin"
                      onClick={() => setSettingsOpen(false)}
                    >
                      <span>Whitelist &amp; accounts</span>
                      <ArrowRight aria-hidden className="text-muted" size={16} />
                    </Link>
                  </section>
                </>
              )}
              <Separator />
              {/* The only sign-out on phones: the mobile top bar deliberately keeps just the brand,
                  health and display controls, so it has to live here. */}
              <section className="flex flex-col gap-3">
                <SectionLabel>Session</SectionLabel>
                {identity && (
                  <p className="tabular text-faint text-xs">
                    Signed in as {shortAddr(identity.address, 6, 6)}
                  </p>
                )}
                <Button
                  className="h-11 self-start"
                  variant="danger-soft"
                  onPress={() => void signOut()}
                >
                  <LogOut aria-hidden size={16} />
                  Sign out
                </Button>
              </section>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  );
};
