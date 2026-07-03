'use client';

import { useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import { useCallback, useEffect, useState } from 'react';
import { type ActivationView, copybotApi } from '@/infrastructure/api/client';
import { Button, Card, EmptyState } from '@/presentation/ui';
import { ActivationWizard } from './activation-wizard';
import { LeaderAddWizard } from './leader-add-wizard';

/**
 * The copy-bot tab (desktop-only, SPEC §13). On entry it provisions the account's custody wallet (idempotent) and
 * reads the activation state, then routes: not-yet-`done` → the first-activation wizard; `done` → the activated
 * surface (signing status + add-a-leader). Provisioning that isn't wired server-side yet (no Privy app secret) is
 * surfaced as a calm notice, never a crash — nothing signs this wave.
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; view: ActivationView };

export function BotPanel() {
  const { wallets } = useSolanaWallets();
  const embeddedAddress = wallets[0]?.address;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [leaderWizardOpen, setLeaderWizardOpen] = useState(false);
  const [leaderAdded, setLeaderAdded] = useState(false);

  const load = useCallback(async () => {
    try {
      // Provision is idempotent — safe to call on every entry; it returns the current state.
      const view = await copybotApi.provision(embeddedAddress);
      setPhase({ kind: 'ready', view });
    } catch {
      // A 5xx typically means provisioning isn't wired yet (no PRIVY_APP_SECRET on the server). Fall back to a
      // plain state read so an already-provisioned account still works; otherwise show the unavailable notice.
      try {
        const view = await copybotApi.activationState();
        if (view.activation) return setPhase({ kind: 'ready', view });
      } catch {
        /* fall through to the unavailable notice */
      }
      setPhase({ kind: 'unavailable' });
    }
  }, [embeddedAddress]);

  useEffect(() => {
    // Wait until Privy has surfaced the embedded wallet before provisioning (its address is the input).
    if (embeddedAddress === undefined) return;
    void load();
  }, [embeddedAddress, load]);

  if (phase.kind === 'loading' || embeddedAddress === undefined) {
    return <EmptyState title="Loading your bot…" hint="Preparing your custody wallet." />;
  }

  if (phase.kind === 'unavailable') {
    return (
      <EmptyState
        variant="error"
        title="Copy-bot custody isn't available yet"
        hint="Live custody provisioning is being finalized. Check back soon — no funds are at risk."
        onRetry={() => {
          setPhase({ kind: 'loading' });
          void load();
        }}
      />
    );
  }

  const { view } = phase;
  const done = view.activation?.activationStep === 'done';

  if (!done) {
    return <ActivationWizard view={view} onAdvance={load} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display font-semibold text-lg text-text">
              Your copy-bot is active
            </h2>
            <p className="mt-1 max-w-xl text-muted text-sm">
              Add the leaders you want to mirror. Every leader is created <strong>stopped</strong> —
              nothing copies until you press Start.
            </p>
          </div>
          <Button onClick={() => setLeaderWizardOpen(true)}>Add a leader</Button>
        </div>
        <SigningStatus view={view} />
        {leaderAdded && (
          <p className="mt-4 rounded-md bg-profit/10 px-3 py-2 text-profit text-sm">
            Leader added (stopped). Start it from your bot settings when you're ready.
          </p>
        )}
      </Card>

      <LeaderAddWizard
        open={leaderWizardOpen}
        ownAddress={view.address}
        onClose={() => setLeaderWizardOpen(false)}
        onAdded={() => {
          setLeaderAdded(true);
          setLeaderWizardOpen(false);
          void load();
        }}
      />
    </div>
  );
}

/** The per-account signing readiness (why the bot may or may not sign live yet — SPEC §3). */
function SigningStatus({ view }: { view: ActivationView }) {
  const ready = view.signingReady;
  return (
    <div className="mt-4 grid gap-2 rounded-lg bg-surface-2/50 p-4 text-sm ring-1 ring-border ring-inset">
      <Row label="Session signer" ok={view.activation?.signerAdded === true} />
      <Row
        label={`Funded (≥ ${view.minActivationSol} SOL)`}
        ok={view.balanceSol >= view.minActivationSol}
        detail={`${view.balanceSol.toFixed(4)} SOL`}
      />
      <Row label="At least one started leader" ok={view.startedLeaderCount >= 1} />
      <p className={ready ? 'mt-1 text-profit' : 'mt-1 text-muted'}>
        {ready
          ? 'Ready to sign live once live signing is enabled for the deployment.'
          : 'Signing stays disabled until all three conditions above are met.'}
      </p>
    </div>
  );
}

function Row({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={ok ? 'font-medium text-profit' : 'text-faint'}>
        {detail ? `${detail} · ` : ''}
        {ok ? 'Yes' : 'No'}
      </span>
    </div>
  );
}
