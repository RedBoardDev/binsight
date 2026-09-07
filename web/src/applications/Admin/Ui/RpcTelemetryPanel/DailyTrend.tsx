'use client';

import type { RpcCreditLedgerRow } from '@app/applications/Admin/Domain/rpcTelemetry';
import { aggregateDailyCredits } from '@app/applications/Admin/Domain/rpcTelemetry';
import { fmtAmount, fmtDate } from '@app/applications/Shared/Domain/formatters';
import { Card } from '@heroui/react';

interface DailyTrendProps {
  rows: RpcCreditLedgerRow[];
}

/** Durable per-day spend for the last-7d window — the only view that survives an API restart. */
export const DailyTrend = ({ rows }: DailyTrendProps) => {
  const daily = aggregateDailyCredits(rows);
  const max = daily.reduce((m, d) => Math.max(m, d.credits), 0);

  return (
    <Card.Root>
      <Card.Header className="flex items-center justify-between gap-3">
        <Card.Title>Last 7 days</Card.Title>
        <span className="text-faint text-xs">credits / day</span>
      </Card.Header>
      <Card.Content>
        <div className="flex h-40 items-end justify-between gap-2">
          {daily.map((day) => {
            const height = max > 0 ? Math.max(4, (day.credits / max) * 100) : 0;
            return (
              <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <span className="tabular text-faint text-xs">{fmtAmount(day.credits)}</span>
                <div className="flex w-full flex-1 items-end">
                  <div
                    className="w-full rounded-t-sm bg-muted/60"
                    style={{ height: `${height}%` }}
                    title={`${day.calls} calls`}
                  />
                </div>
                <span className="text-faint text-xs">{fmtDate(day.dayMs)}</span>
              </div>
            );
          })}
        </div>
      </Card.Content>
    </Card.Root>
  );
};
