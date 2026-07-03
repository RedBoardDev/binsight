'use client';

import { useSigners } from '@privy-io/react-auth';
import { useExportWallet } from '@privy-io/react-auth/solana';
import { useCallback, useEffect, useState } from 'react';
import { type ActivationView, copybotApi } from '@/infrastructure/api/client';
import { PRIVY_SIGNER_ID } from '@/infrastructure/config';
import { useCopy } from '@/presentation/hooks/use-copy';
import { Button, Card, cn, IconCheck, IconCopy } from '@/presentation/ui';

/** How often the deposit step re-reads the live balance so the user sees their funds land. */
const DEPOSIT_POLL_MS = 6000;

/**
 * First-activation wizard (once per account, resumable per `activation_step`): consent (add the coffre session
 * signer) → deposit (fund ≥ 1 SOL) → export (offer the key + the bot-exclusivity warning). Desktop-only (SPEC §13).
 * The persisted step drives which screen shows on entry; deposit→export is a local sub-step (the API advances
 * consent→deposit on consent-complete and deposit→done on export-ack).
 */
type Props = { view: ActivationView; onAdvance: () => Promise<void> };

export function ActivationWizard({ view, onAdvance }: Props) {
  const step = view.activation?.activationStep ?? 'consent';
  // Within the persisted 'deposit' state the UI walks deposit → export locally (export-ack lands 'done').
  const [subStep, setSubStep] = useState<'deposit' | 'export'>(
    step === 'export' ? 'export' : 'deposit',
  );

  const active: 'consent' | 'deposit' | 'export' =
    step === 'consent' ? 'consent' : step === 'export' ? 'export' : subStep;

  return (
    <Card className="mx-auto w-full max-w-2xl p-6">
      <Stepper active={active} />
      {active === 'consent' && <ConsentStep view={view} onAdvance={onAdvance} />}
      {active === 'deposit' && <DepositStep view={view} onContinue={() => setSubStep('export')} />}
      {active === 'export' && (
        <ExportStep view={view} onBack={() => setSubStep('deposit')} onAdvance={onAdvance} />
      )}
    </Card>
  );
}

const STEPS: { key: 'consent' | 'deposit' | 'export'; label: string }[] = [
  { key: 'consent', label: 'Grant access' },
  { key: 'deposit', label: 'Fund' },
  { key: 'export', label: 'Backup' },
];

function Stepper({ active }: { active: 'consent' | 'deposit' | 'export' }) {
  const idx = STEPS.findIndex((s) => s.key === active);
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={cn(
              'grid size-6 place-items-center rounded-full font-semibold',
              i < idx && 'bg-profit/15 text-profit',
              i === idx && 'bg-accent text-bg',
              i > idx && 'bg-surface-2 text-faint',
            )}
          >
            {i < idx ? <IconCheck size={13} /> : i + 1}
          </span>
          <span className={cn(i === idx ? 'text-text' : 'text-muted')}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

function ConsentStep({
  view,
  onAdvance,
}: {
  view: ActivationView;
  onAdvance: () => Promise<void>;
}) {
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = view.address;
  const policyId = view.activation?.policyId ?? null;
  const configured = PRIVY_SIGNER_ID.length > 0;

  async function grant() {
    if (!address || !configured) return;
    setBusy(true);
    setError(null);
    try {
      // The CLIENT consent: add the coffre session signer to the user's wallet, scoped to their Wall A policy.
      await addSigners({
        address,
        signers: [{ signerId: PRIVY_SIGNER_ID, policyIds: policyId ? [policyId] : [] }],
      });
      await copybotApi.consentComplete();
      await onAdvance();
    } catch {
      setError('Could not grant access. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="font-display font-semibold text-lg text-text">Let the bot trade for you</h2>
      <ul className="mt-3 space-y-2 text-muted text-sm">
        <li>
          • The bot can open and close DLMM positions and swap via Jupiter{' '}
          <strong>with your funds</strong>.
        </li>
        <li>
          • It can <strong>never send funds to any address but your own</strong> — every rule is
          enforced on-chain.
        </li>
        <li>
          • You stay in control: this access is <strong>revocable at any time</strong>.
        </li>
      </ul>
      {!configured && (
        <p className="mt-4 rounded-md bg-loss/10 px-3 py-2 text-loss text-sm">
          Signing isn't configured for this deployment yet (missing signer id). You can't grant
          access until it is.
        </p>
      )}
      {error && <p className="mt-4 text-loss text-sm">{error}</p>}
      <div className="mt-6 flex justify-end">
        <Button onClick={grant} disabled={busy || !configured || !address}>
          {busy ? 'Granting…' : 'Grant access'}
        </Button>
      </div>
    </div>
  );
}

function DepositStep({ view, onContinue }: { view: ActivationView; onContinue: () => void }) {
  const { copied, copy } = useCopy();
  const [balanceSol, setBalanceSol] = useState(view.balanceSol);
  const address = view.address ?? '';
  const min = view.minActivationSol;
  const funded = balanceSol >= min;

  const poll = useCallback(async () => {
    try {
      const next = await copybotApi.activationState();
      setBalanceSol(next.balanceSol);
    } catch {
      /* transient — keep the last value */
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void poll(), DEPOSIT_POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  return (
    <div>
      <h2 className="font-display font-semibold text-lg text-text">Fund your bot wallet</h2>
      <p className="mt-2 text-muted text-sm">
        Send SOL to your custody wallet below. A <strong>minimum of {min} SOL</strong> is required
        before the bot can start copying.
      </p>

      <div className="mt-4 rounded-lg border border-border bg-surface-2/40 p-4">
        <p className="text-faint text-xs">Your custody wallet address</p>
        <div className="mt-1.5 flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-sm text-text">{address}</code>
          <button
            type="button"
            onClick={() => copy(address)}
            title="Copy address"
            className="shrink-0 rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-text"
          >
            {copied ? <IconCheck className="text-profit" /> : <IconCopy />}
          </button>
        </div>
        <p className="mt-2 text-faint text-xs">
          A scannable QR code is coming soon — copy the address for now.
        </p>
      </div>

      <div
        className={cn(
          'mt-4 flex items-center justify-between rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
          funded
            ? 'bg-profit/10 text-profit ring-profit/30'
            : 'bg-surface-2/50 text-muted ring-border',
        )}
      >
        <span>Current balance</span>
        <span className="font-semibold">{balanceSol.toFixed(4)} SOL</span>
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={onContinue}>{funded ? 'Continue' : 'Continue anyway'}</Button>
      </div>
    </div>
  );
}

function ExportStep({
  view,
  onBack,
  onAdvance,
}: {
  view: ActivationView;
  onBack: () => void;
  onAdvance: () => Promise<void>;
}) {
  const { exportWallet } = useExportWallet();
  const [busy, setBusy] = useState(false);
  const address = view.address ?? undefined;

  async function doExport() {
    try {
      await exportWallet(address ? { address } : undefined);
    } catch {
      /* the Privy modal handles its own errors; nothing to persist here */
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await copybotApi.exportAck();
      await onAdvance();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="font-display font-semibold text-lg text-text">Back up your wallet key</h2>
      <p className="mt-2 text-muted text-sm">
        You can export your wallet's private key to keep a personal backup (import it into Phantom,
        Backpack, …). Privy shows it to you directly — it never touches our servers.
      </p>
      <p className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-sm text-warn">
        ⚠️ This is the <strong>bot's wallet</strong>. Any position you open manually on it will be
        closed by the bot. Keep manual trading on a separate wallet.
      </p>
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="subtle" onClick={doExport}>
            Export private key
          </Button>
          <Button onClick={finish} disabled={busy}>
            {busy ? 'Finishing…' : 'Finish'}
          </Button>
        </div>
      </div>
    </div>
  );
}
