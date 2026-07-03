'use client';

// Withdrawal Path B (SPEC §2.2): 100% CLIENT-SIDE with the user's OWN Privy authority — the coffre NEVER signs a
// withdrawal. F5 firewall: this file imports ONLY @privy-io/react-auth (+ @solana/web3.js to build the transfer) and
// the read-only API client; it never touches the coffre signer / authorization key. The client-side confirmation is
// the ONLY barrier (XSS residual risk accepted, SPEC §17.1) — no address book, no step-up.
import {
  useSignAndSendTransaction,
  useWallets as useSolanaWallets,
} from '@privy-io/react-auth/solana';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { copybotApi, type WithdrawableView } from '@/infrastructure/api/client';
import { Button, Card, Input } from '@/presentation/ui';

/** `ABC…WXYZ` — the recap short form so the user re-reads exactly where the funds go before confirming. */
function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** A valid base58 Solana address (parses to a PublicKey). Pure client check — the confirmation is the real barrier. */
function isValidAddress(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

type Phase =
  | { kind: 'form' }
  | { kind: 'confirm' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * The withdraw screen in the Bot funds area (desktop-only, SPEC §13). Paste an external address + amount (capped to
 * the free SOL), review the recap, then sign+send with the user's OWN Privy embedded wallet. On success it records a
 * lightweight withdrawal-ack so the account-teardown gate (SPEC §2.4) sees a completed withdrawal.
 */
export function WithdrawPanel() {
  const { wallets } = useSolanaWallets();
  const wallet = wallets[0];
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const [view, setView] = useState<WithdrawableView | null>(null);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  const loadWithdrawable = useCallback(async () => {
    try {
      setView(await copybotApi.withdrawable());
    } catch {
      /* transient — keep the last value; the amount cap simply stays conservative */
    }
  }, []);

  useEffect(() => {
    void loadWithdrawable();
  }, [loadWithdrawable]);

  const maxSol = view?.withdrawableSol ?? 0;
  const amountSol = Number(amount);
  const amountValid = Number.isFinite(amountSol) && amountSol > 0 && amountSol <= maxSol;
  const addressValid = isValidAddress(destination.trim());
  const canReview = addressValid && amountValid && Boolean(wallet);

  async function send() {
    if (!wallet || !canReview) return;
    setPhase({ kind: 'sending' });
    try {
      const from = new PublicKey(wallet.address);
      const to = new PublicKey(destination.trim());
      const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
      const tx = new Transaction();
      tx.feePayer = from;
      // Placeholder blockhash: Privy's signAndSendTransaction fetches a FRESH blockhash and repopulates it before
      // signing + broadcasting through its own RPC (CSP-allowed *.rpc.privy.systems). We only need a well-formed
      // message to serialize here.
      tx.recentBlockhash = PublicKey.default.toBase58();
      tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
      const transaction = new Uint8Array(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
      // The USER signs + sends with their OWN Privy authority (never the coffre).
      await signAndSendTransaction({ transaction, wallet });
      // Record the completed withdrawal so the teardown gate sees it (best-effort — the transfer already landed).
      await copybotApi.withdrawalAck().catch(() => {});
      setPhase({ kind: 'done' });
      setDestination('');
      setAmount('');
      void loadWithdrawable();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'Withdrawal failed' });
    }
  }

  return (
    <Card className="p-5">
      <h3 className="font-display font-semibold text-base text-text">Withdraw SOL</h3>
      <p className="mt-1 text-muted text-sm">
        Send SOL from your bot wallet to any external address. You sign it yourself — the bot never
        moves funds off your wallet.
      </p>

      {phase.kind === 'done' && (
        <p className="mt-4 rounded-md bg-profit/10 px-3 py-2 text-profit text-sm">
          Withdrawal submitted. Your balance updates once it confirms on-chain.
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="mt-4 rounded-md bg-loss/10 px-3 py-2 text-loss text-sm">
          {phase.message} — nothing was sent. Please try again.
        </p>
      )}

      <div className="mt-4 flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3 text-sm ring-1 ring-border ring-inset">
        <span className="text-muted">Available to withdraw</span>
        <span className="font-semibold text-text">{maxSol.toFixed(4)} SOL</span>
      </div>

      {phase.kind === 'confirm' ? (
        <div className="mt-4">
          <div className="rounded-lg border border-border bg-surface-2/40 p-4 text-sm">
            <p className="text-text">
              You will send <strong>{amountSol.toFixed(4)} SOL</strong> to{' '}
              <code className="font-mono text-text" title={destination.trim()}>
                {shortAddr(destination.trim())}
              </code>
              .
            </p>
            <p className="mt-2 text-faint text-xs">
              This transfer is irreversible. Double-check the address — it cannot be undone.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setPhase({ kind: 'form' })}>
              Back
            </Button>
            <Button onClick={send}>Confirm &amp; send</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="wd-destination" className="text-faint text-xs">
              Destination address
            </label>
            <Input
              id="wd-destination"
              className="mt-1 font-mono"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="External Solana address"
              spellCheck={false}
              autoComplete="off"
            />
            {destination.trim().length > 0 && !addressValid && (
              <span className="mt-1 block text-loss text-xs">Not a valid Solana address.</span>
            )}
          </div>
          <div>
            <label htmlFor="wd-amount" className="text-faint text-xs">
              Amount (SOL)
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                id="wd-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.0001"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
              />
              <Button
                variant="subtle"
                onClick={() => setAmount(String(maxSol))}
                disabled={maxSol <= 0}
              >
                Max
              </Button>
            </div>
            {amount.length > 0 && !amountValid && (
              <span className="mt-1 block text-loss text-xs">
                Enter an amount between 0 and {maxSol.toFixed(4)} SOL.
              </span>
            )}
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => setPhase({ kind: 'confirm' })}
              disabled={!canReview || phase.kind === 'sending'}
            >
              {phase.kind === 'sending' ? 'Sending…' : 'Review withdrawal'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
