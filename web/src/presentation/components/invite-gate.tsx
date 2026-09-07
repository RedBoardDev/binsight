'use client';

import { type FormEvent, useState } from 'react';
import { authApi, type RedeemInviteError } from '@/infrastructure/api/client';
import { Button, Input } from '@/presentation/ui';
import { AuthScreen } from './auth-screen';

/** One precise message per typed redeem failure — never a generic boolean (SPEC UX #86). */
const REDEEM_ERROR_MESSAGES: Record<Exclude<RedeemInviteError, 'already_registered'>, string> = {
  invalid_code: 'That invite code is not valid. Check it and try again.',
  code_expired: 'That invite code has expired. Ask for a new one.',
  code_used: 'That invite code has already been used. Ask for a new one.',
  network: 'Could not reach the server — please retry.',
};

/**
 * Invite gate: a verified Privy login without a binsight account lands here. Access is
 * invitation-only — a single-use code creates the account (SPEC §1). The short ToS acknowledgment
 * is mandatory at signup.
 */
export function InviteGate({ onRegistered }: { onRegistered: () => void }) {
  const [code, setCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authApi.redeemInvite(code.trim());
    setBusy(false);
    // `already_registered` means the account already exists — that IS the goal state, continue.
    if (res.ok || res.error === 'already_registered') {
      onRegistered();
      return;
    }
    setError(REDEEM_ERROR_MESSAGES[res.error]);
  }

  return (
    <AuthScreen title="Almost there" subtitle="Binsight is invite-only. Enter your invite code.">
      <form onSubmit={onSubmit}>
        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-border bg-base px-3.5 py-3 text-muted text-xs">
          <p>Automated trading involves risk — you can lose the funds you deposit.</p>
          <p>
            Binsight is non-custodial: only you can recover or export your wallet. A lost login
            means lost funds.
          </p>
          <p>No profit is guaranteed.</p>
        </div>
        <label className="mb-4 flex items-start gap-2.5 text-text text-xs">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-accent"
          />
          <span>I understand and accept the terms above.</span>
        </label>
        <label htmlFor="invite-code" className="sr-only">
          Invite code
        </label>
        <Input
          id="invite-code"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Invite code"
          aria-invalid={error !== null}
          className="px-3.5 py-2.5 font-mono text-sm"
        />
        {error && (
          <p role="alert" className="mt-2 text-loss text-xs">
            {error}
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || !accepted || code.trim().length === 0}
          className="mt-5 w-full"
        >
          {busy ? 'Redeeming…' : 'Redeem invite'}
        </Button>
      </form>
    </AuthScreen>
  );
}
