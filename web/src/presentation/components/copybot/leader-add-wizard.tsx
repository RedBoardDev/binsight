'use client';

import { useState } from 'react';
import {
  copybotApi,
  type LeaderRejectReason,
  type NewLeaderBody,
} from '@/infrastructure/api/client';
import { Button, Input, Modal } from '@/presentation/ui';

/** Human copy per rejection code (the server returns a stable functional reason). */
const REJECT_MESSAGE: Record<LeaderRejectReason, string> = {
  invalid_address: "That's not a valid Solana address.",
  own_wallet: "That's your own bot wallet — you can't copy yourself.",
  duplicate: 'You already follow this leader.',
  no_dlmm_activity: 'This wallet has no DLMM activity to copy.',
};

const DEFAULT_MAX_TRADE_SIZE_SOL = '1';
const DEFAULT_TRADE_RATIO_PCT = '100';

type Props = {
  open: boolean;
  ownAddress: string | null;
  onClose: () => void;
  onAdded: () => void;
};

/**
 * Leader-add wizard (reusable): paste + validate an address (rejects a bad address, the user's own bot wallet, a
 * duplicate, or a no-DLMM-activity wallet), then set the pre-filled sizing/exposure/two-sided and create the leader
 * STOPPED. Two-sided defaults OFF (SOL leg only) — the safe, simpler copy.
 */
export function LeaderAddWizard({ open, ownAddress, onClose, onAdded }: Props) {
  const [address, setAddress] = useState('');
  const [checked, setChecked] = useState<'ok' | LeaderRejectReason | null>(null);
  const [checking, setChecking] = useState(false);
  const [maxTradeSizeSol, setMaxTradeSizeSol] = useState(DEFAULT_MAX_TRADE_SIZE_SOL);
  const [tradeRatioPct, setTradeRatioPct] = useState(DEFAULT_TRADE_RATIO_PCT);
  const [maxTotalExposureSol, setMaxTotalExposureSol] = useState('');
  const [twoSided, setTwoSided] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAddress('');
    setChecked(null);
    setMaxTradeSizeSol(DEFAULT_MAX_TRADE_SIZE_SOL);
    setTradeRatioPct(DEFAULT_TRADE_RATIO_PCT);
    setMaxTotalExposureSol('');
    setTwoSided(false);
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function check() {
    const addr = address.trim();
    if (!addr) return;
    setChecking(true);
    setError(null);
    try {
      const res = await copybotApi.validateLeader(addr);
      setChecked(res.ok ? 'ok' : res.reason);
    } catch {
      setError('Could not validate the address. Please try again.');
    } finally {
      setChecking(false);
    }
  }

  const ratioNum = Number(tradeRatioPct);
  const sizeNum = Number(maxTradeSizeSol);
  const ratioOver100 = Number.isFinite(ratioNum) && ratioNum > 100;
  const numbersValid =
    Number.isFinite(sizeNum) && sizeNum > 0 && Number.isFinite(ratioNum) && ratioNum > 0;

  async function submit() {
    if (checked !== 'ok' || !numbersValid) return;
    const exposureTrim = maxTotalExposureSol.trim();
    const exposureNum = exposureTrim === '' ? null : Number(exposureTrim);
    if (exposureNum !== null && (!Number.isFinite(exposureNum) || exposureNum < 0)) {
      setError('Max total exposure must be a non-negative number (or left blank).');
      return;
    }
    const body: NewLeaderBody = {
      address: address.trim(),
      maxTradeSizeSol: sizeNum,
      tradeRatioPct: ratioNum,
      maxTotalExposureSol: exposureNum,
      twoSidedMode: twoSided ? 'on' : 'off',
    };
    setSubmitting(true);
    setError(null);
    try {
      const res = await copybotApi.addLeader(body);
      if (res.ok) {
        reset();
        onAdded();
      } else {
        setError(REJECT_MESSAGE[res.reason]);
        setChecked(res.reason);
      }
    } catch {
      setError('Could not add the leader. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Add a leader" className="max-w-lg">
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="leader-address" className="mb-1.5 block text-muted text-xs">
            Leader wallet address
          </label>
          <div className="flex gap-2">
            <Input
              id="leader-address"
              value={address}
              placeholder="Paste a Solana wallet address"
              onChange={(e) => {
                setAddress(e.target.value);
                setChecked(null);
              }}
            />
            <Button variant="subtle" onClick={check} disabled={checking || address.trim() === ''}>
              {checking ? 'Checking…' : 'Check'}
            </Button>
          </div>
          {checked === 'ok' && (
            <p className="mt-1.5 text-profit text-xs">Valid leader — ready to add.</p>
          )}
          {checked && checked !== 'ok' && (
            <p className="mt-1.5 text-loss text-xs">{REJECT_MESSAGE[checked]}</p>
          )}
          {ownAddress && (
            <p className="mt-1 text-faint text-xs">You can't copy your own bot wallet.</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Max trade size (SOL)">
            <Input
              type="number"
              min="0"
              step="0.1"
              value={maxTradeSizeSol}
              onChange={(e) => setMaxTradeSizeSol(e.target.value)}
            />
          </Field>
          <Field label="Copy ratio (%)">
            <Input
              type="number"
              min="1"
              step="1"
              value={tradeRatioPct}
              onChange={(e) => setTradeRatioPct(e.target.value)}
            />
          </Field>
        </div>
        {ratioOver100 && (
          <p className="-mt-2 text-warn text-xs">
            Above 100% amplifies the leader's size — you'll deploy more than they do.
          </p>
        )}

        <Field label="Max total exposure (SOL, optional)">
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="No cap"
            value={maxTotalExposureSol}
            onChange={(e) => setMaxTotalExposureSol(e.target.value)}
          />
        </Field>

        <label className="flex items-center gap-2.5 text-sm text-text">
          <input
            type="checkbox"
            checked={twoSided}
            onChange={(e) => setTwoSided(e.target.checked)}
            className="size-4 accent-accent"
          />
          Copy two-legged positions (also buy the paired token)
        </label>

        {error && <p className="text-loss text-sm">{error}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || checked !== 'ok' || !numbersValid}>
            {submitting ? 'Adding…' : 'Add leader (stopped)'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-muted text-xs">{label}</span>
      {children}
    </div>
  );
}
