'use client';

import type { Health, SourceStatus } from '@binsight/shared';
import { useEffect, useRef, useState } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { fmtRelative } from '@/domain/format';
import { cn, StatusDot, Tooltip } from '@/presentation/ui';

function overall(health: Health | null, connected: boolean): SourceStatus {
  if (!health || !connected) return 'down';
  const statuses = health.sources.map((s) => s.status);
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('lagging') || !health.wsConnected) return 'lagging';
  return 'ok';
}

const LABEL: Record<SourceStatus, string> = { ok: 'Live', lagging: 'Degraded', down: 'Offline' };
const SOURCE_LABEL: Record<SourceStatus, string> = { ok: 'OK', lagging: 'Lagging', down: 'Down' };
const POPOVER_ID = 'health-popover';

export function HealthIndicator() {
  const health = usePortfolio((s) => s.health);
  const connected = usePortfolio((s) => s.connected);
  const status = overall(health, connected);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The detail reveals on hover (pure CSS, below) OR when toggled open by click / keyboard — so it is
  // reachable on touch and by keyboard, not hover-only. While toggled open, close it on Escape or an
  // outside pointer; the hover path needs no JS.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const hasDetail = health !== null;

  return (
    <div ref={rootRef} className="group relative">
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? POPOVER_ID : undefined}
        onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
        className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted text-sm transition-colors group-hover:bg-hover group-hover:text-text focus-visible:bg-hover focus-visible:text-text"
      >
        <StatusDot status={status} />
        <span>{LABEL[status]}</span>
      </button>
      {health && (
        <div
          id={POPOVER_ID}
          className={cn(
            'absolute top-full right-0 z-30 w-64 pt-1.5 transition duration-150 ease-spring',
            // Click / keyboard path (JS-controlled):
            open ? 'visible translate-y-0 opacity-100' : 'invisible translate-y-1 opacity-0',
            // Hover path (pure CSS) — either one reveals it:
            'group-hover:visible group-hover:translate-y-0 group-hover:opacity-100',
          )}
        >
          <SourcePopover health={health} />
        </div>
      )}
    </div>
  );
}

function SourcePopover({ health }: { health: Health }) {
  const now = Date.now();
  return (
    <Tooltip className="p-2">
      {health.sources.length === 0 && (
        <p className="px-2 py-1.5 text-faint text-xs">No source data yet.</p>
      )}
      {health.sources.map((src) => (
        <div
          key={src.name}
          className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
        >
          <div className="flex items-center gap-2">
            <StatusDot status={src.status} />
            <span className="font-medium text-sm text-text capitalize">{src.name}</span>
            <span className="text-faint text-xs">{SOURCE_LABEL[src.status]}</span>
          </div>
          <span className="text-faint text-xs">{src.detail ?? fmtRelative(src.lastOkAt, now)}</span>
        </div>
      ))}
      <div className="mt-1 border-border border-t px-2 pt-2 text-faint text-xs">
        {health.effectiveRps.toFixed(1)} rps · up {Math.floor(health.uptimeSeconds / 3600)}h
      </div>
    </Tooltip>
  );
}
