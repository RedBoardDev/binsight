'use client';

import type { AccessEntry, WalletOverview } from '@binsight/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { shortAddr } from '@/domain/format';
import {
  adminApi,
  api,
  authApi,
  type CopybotProcessStatus,
  type CopybotQuarantineRow,
  type CopybotStatusView,
} from '@/infrastructure/api/client';
import { Button, Input, Modal } from '@/presentation/ui';

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type Tab = 'access' | 'wallets' | 'copybot';
const TAB_LABELS: Record<Tab, string> = {
  access: 'Access',
  wallets: 'Wallets',
  copybot: 'Copy-bot',
};
/** Refresh cadence for the copy-bot status panel — keeps online/stale honest without hammering the API. */
const COPYBOT_POLL_MS = 5_000;

const day = (ms: number) => new Date(ms).toLocaleDateString();
function ago(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

type Confirm = { title: string; body: string; confirmLabel: string; onConfirm: () => void };

function ConfirmModal({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  return (
    <Modal open={confirm !== null} onClose={onClose} title={confirm?.title}>
      <div className="flex flex-col gap-5 p-5">
        <p className="text-muted text-sm leading-relaxed">{confirm?.body}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={() => {
              confirm?.onConfirm();
              onClose();
            }}
            className="rounded-lg bg-loss px-4 py-2 font-medium text-bg text-sm transition-opacity hover:opacity-90"
          >
            {confirm?.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('access');

  useEffect(() => {
    authApi
      .me()
      .then((me) => {
        const isOwner = me.registered && me.isOwner;
        setAllowed(isOwner);
        if (!isOwner) router.replace('/');
      })
      .catch(() => {
        setAllowed(false);
        router.replace('/login');
      });
  }, [router]);

  if (allowed !== true) {
    return <main className="grid min-h-dvh place-items-center text-muted text-sm">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-semibold text-lg text-text tracking-tight">Admin</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/rpc" className="text-muted text-sm transition-colors hover:text-text">
            RPC Credits
          </Link>
          <Link href="/" className="text-muted text-sm transition-colors hover:text-text">
            ← Dashboard
          </Link>
        </div>
      </div>

      <div className="mb-6 inline-flex rounded-lg bg-surface-2/50 p-0.5 ring-1 ring-border ring-inset">
        {(['access', 'wallets', 'copybot'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
              tab === t ? 'bg-surface text-text' : 'text-muted hover:text-text'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'access' ? <AccessTab /> : tab === 'wallets' ? <WalletsTab /> : <CopybotTab />}
    </main>
  );
}

function AccessTab() {
  const [rows, setRows] = useState<AccessEntry[]>([]);
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const load = useCallback(() => {
    api
      .access()
      .then(setRows)
      .catch(() => setError('Could not load access list.'));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ok = await api.invite(address.trim(), note.trim());
    setBusy(false);
    if (ok) {
      setAddress('');
      setNote('');
      load();
    } else {
      setError('Could not invite — check the address.');
    }
  }

  function askRevoke(r: AccessEntry) {
    setConfirm({
      title: r.status === 'joined' ? 'Revoke account access' : 'Remove invite',
      body:
        r.status === 'joined'
          ? `Delete the account for ${shortAddr(r.address)} and remove its invite. They lose access immediately and can't re-register. Their watched wallets' data is kept (shared) — only live monitoring of wallets nobody else watches stops.`
          : `Remove the invite for ${shortAddr(r.address)}. This wallet won't be able to register.`,
      confirmLabel: r.status === 'joined' ? 'Revoke access' : 'Remove invite',
      onConfirm: async () => {
        if (await api.revoke(r.address)) load();
        else setError('Could not revoke.');
      },
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={onInvite}
        className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 sm:flex-row"
      >
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Wallet address to invite"
          spellCheck={false}
          className="flex-1 px-3 py-2 font-mono text-sm"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="px-3 py-2 text-sm sm:w-40"
        />
        <Button type="submit" disabled={busy || !ADDRESS_RE.test(address.trim())}>
          Invite
        </Button>
      </form>
      {error && <p className="text-loss text-xs">{error}</p>}

      <ul className="flex flex-col gap-2">
        {rows.length === 0 && <li className="text-muted text-sm">No accounts or invites yet.</li>}
        {rows.map((r) => (
          <li
            key={r.address}
            className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate font-mono text-sm text-text">
                {r.address}
                {r.isOwner && <span className="text-accent text-xs">owner</span>}
              </p>
              <p className="text-faint text-xs">
                <span className={r.status === 'joined' ? 'text-profit' : 'text-warn'}>
                  {r.status === 'joined' ? 'joined' : 'invited'}
                </span>
                {r.status === 'joined'
                  ? ` · ${r.wallets.length} wallet${r.wallets.length === 1 ? '' : 's'} · ${day(r.createdAt)}`
                  : r.note
                    ? ` · ${r.note}`
                    : ''}
              </p>
            </div>
            {r.isOwner ? (
              <span className="ml-3 shrink-0 text-faint text-xs">—</span>
            ) : (
              <button
                type="button"
                onClick={() => askRevoke(r)}
                className="ml-3 shrink-0 text-loss text-xs transition-opacity hover:opacity-80"
              >
                {r.status === 'joined' ? 'Revoke' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function WalletsTab() {
  const [rows, setRows] = useState<WalletOverview[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminWallets()
      .then(setRows)
      .catch(() => setError('Could not load wallets.'));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-loss text-xs">{error}</p>}
      {rows.length === 0 && !error && (
        <p className="text-muted text-sm">No monitored wallets yet.</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-faint text-xs">
                <th className="px-4 py-2.5 text-left font-medium">Wallet</th>
                <th className="px-4 py-2.5 text-right font-medium">Watchers</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Open</th>
                <th className="px-4 py-2.5 text-right font-medium">Closed</th>
                <th className="px-4 py-2.5 text-right font-medium">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.address} className="border-border/60 border-b last:border-0">
                  <td className="px-4 py-2.5 font-mono text-text">{shortAddr(w.address)}</td>
                  <td className="px-4 py-2.5 text-right text-muted">{w.watchers}</td>
                  <td className="px-4 py-2.5">
                    {w.ready === false ? (
                      <span className="text-warn text-xs">indexing… ({w.indexedTxs ?? 0} txs)</span>
                    ) : (
                      <span className="text-profit text-xs">ready</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted">{w.openPositions}</td>
                  <td className="px-4 py-2.5 text-right text-muted">{w.closedPositions}</td>
                  <td className="px-4 py-2.5 text-right text-faint">{ago(w.lastUpdate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Copy-bot operator surface (SPEC §10/§13) ──────────────────────────────────────────────────────
// The status `detail` is loose jsonb (the brain's v2 snapshot / the coffre's signing state), so every field is
// read defensively — a shape drift degrades to "—", never a crash.
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const fmtInt = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : '0';
const fmtSol = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—';

function CopybotTab() {
  const [status, setStatus] = useState<CopybotStatusView | null>(null);
  const [alerts, setAlerts] = useState<CopybotQuarantineRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [killMsg, setKillMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    adminApi
      .copybotStatus()
      .then(setStatus)
      .catch(() => setError('Could not load bot status.'));
  }, []);
  const loadAlerts = useCallback(() => {
    adminApi
      .copybotQuarantine()
      .then(setAlerts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStatus();
    loadAlerts();
    const id = setInterval(loadStatus, COPYBOT_POLL_MS);
    return () => clearInterval(id);
  }, [loadStatus, loadAlerts]);

  function askKill() {
    setConfirm({
      title: 'GLOBAL KILL — halt all copy trading',
      body: 'Force the global kill switch ON for EVERY user. All bot runtimes stop opening new positions within ~100ms — exits and reconciliation keep running. Use this the moment something looks wrong. Trading is re-enabled later, per user, from their config.',
      confirmLabel: 'Engage GLOBAL KILL',
      onConfirm: async () => {
        setBusy(true);
        setKillMsg(null);
        setError(null);
        try {
          const res = await adminApi.copybotKill();
          setKillMsg(`Kill switch engaged for ${res.killed} user${res.killed === 1 ? '' : 's'}.`);
          loadStatus(); // read-back — never render an optimistic result we can't confirm
        } catch {
          setError('Kill failed — retry.');
        } finally {
          setBusy(false);
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Emergency stop — prominent + full-width on mobile so it's tappable away from the desk (SPEC §13). */}
      <div className="rounded-xl border border-loss/40 bg-loss/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-semibold text-sm text-text">Emergency stop</p>
            <p className="text-muted text-xs">
              Halt all new opens across every user. Exits keep running.
            </p>
          </div>
          <button
            type="button"
            onClick={askKill}
            disabled={busy}
            className="w-full shrink-0 rounded-lg bg-loss px-5 py-3 font-semibold text-bg text-sm transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto"
          >
            {busy ? 'Killing…' : 'GLOBAL KILL'}
          </button>
        </div>
        {killMsg && <p className="mt-3 text-profit text-xs">{killMsg}</p>}
      </div>

      {error && <p className="text-loss text-xs">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProcessCard name="brain" status={status?.brain ?? null} />
        <ProcessCard name="coffre" status={status?.coffre ?? null} />
      </div>

      <BrainDetail status={status?.brain ?? null} />

      <AlertsList rows={alerts} />

      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function ProcessCard({ name, status }: { name: string; status: CopybotProcessStatus | null }) {
  const online = status?.online === true;
  const dot = status ? (online ? 'bg-profit' : 'bg-loss') : 'bg-faint';
  const label = status ? (online ? 'online' : 'stale') : 'not running';
  const labelColor = status ? (online ? 'text-profit' : 'text-loss') : 'text-faint';
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block size-2 rounded-full ${dot}`} />
          <span className="font-medium text-sm text-text capitalize">{name}</span>
        </div>
        <span className={`text-xs ${labelColor}`}>{label}</span>
      </div>
      <p className="mt-1 text-faint text-xs">
        {status ? `last heartbeat ${ago(status.ts)}` : 'no heartbeat yet'}
      </p>
      {name === 'coffre' && status && (
        <p className="mt-2 text-muted text-xs">
          signing {asRecord(status.detail).signingEnabled === true ? 'enabled' : 'disabled'}
        </p>
      )}
      {name === 'brain' && status && <BrainSummary detail={status.detail} />}
    </div>
  );
}

function BrainSummary({ detail }: { detail: unknown }) {
  const d = asRecord(detail);
  const ws = d.wsConnected;
  const reconcileFails = typeof d.reconcileFailures === 'number' ? d.reconcileFailures : 0;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted text-xs">
      <span>open {fmtInt(d.openPositions)}</span>
      <span>exposure {fmtSol(d.exposureSol)} SOL</span>
      {typeof ws === 'boolean' && (
        <span className={ws ? 'text-profit' : 'text-loss'}>WS {ws ? 'up' : 'down'}</span>
      )}
      {reconcileFails > 0 && <span className="text-warn">reconcile fails {reconcileFails}</span>}
    </div>
  );
}

function BrainDetail({ status }: { status: CopybotProcessStatus | null }) {
  if (!status) return null;
  const d = asRecord(status.detail);
  const leaders = asArray(d.leaders);
  const users = asArray(d.users);
  if (leaders.length === 0 && users.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {leaders.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-faint text-xs">
                <th className="px-4 py-2.5 text-left font-medium">Leader (poll health)</th>
                <th className="px-4 py-2.5 text-right font-medium">Last poll</th>
                <th className="px-4 py-2.5 text-right font-medium">Poll fails</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((l, i) => {
                const fails = typeof l.pollFailures === 'number' ? l.pollFailures : 0;
                const lastPoll = typeof l.lastPollAt === 'number' ? l.lastPollAt : null;
                return (
                  <tr
                    key={str(l.leader) ?? `leader-${i}`}
                    className="border-border/60 border-b last:border-0"
                  >
                    <td className="px-4 py-2.5 font-mono text-text">
                      {shortAddr(str(l.leader) ?? '—')}
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint">
                      {lastPoll ? ago(lastPoll) : 'never'}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right ${fails > 0 ? 'text-warn' : 'text-muted'}`}
                    >
                      {fails}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {users.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-faint text-xs">
                <th className="px-4 py-2.5 text-left font-medium">User</th>
                <th className="px-4 py-2.5 text-right font-medium">Open</th>
                <th className="px-4 py-2.5 text-right font-medium">Exposure SOL</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr
                  key={str(u.userId) ?? `user-${i}`}
                  className="border-border/60 border-b last:border-0"
                >
                  <td className="px-4 py-2.5 font-mono text-text">
                    {shortAddr(str(u.userId) ?? '—')}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted">{fmtInt(u.openPositions)}</td>
                  <td className="px-4 py-2.5 text-right text-muted">{fmtSol(u.exposureSol)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AlertsList({ rows }: { rows: CopybotQuarantineRow[] }) {
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between border-border border-b px-4 py-3">
        <p className="font-medium text-sm text-text">Quarantine / alerts</p>
        <span className="text-faint text-xs">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-muted text-sm">
          No alerts — no quarantined commands or fatal events.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-3 border-border/60 border-b px-4 py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-text text-xs">{r.code ?? '—'}</p>
                <p className="truncate text-faint text-xs">
                  {r.wallet ? `${shortAddr(r.wallet)} · ` : ''}
                  {r.reason ?? ''}
                </p>
              </div>
              <span className="shrink-0 text-faint text-xs">{ago(r.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
