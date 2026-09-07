'use client';

import { useRpcTelemetry } from '@app/applications/Admin/Api/useAdmin.api';
import { methodWeight, todayTotals } from '@app/applications/Admin/Domain/rpcTelemetry';
import { AnomalyCallout } from '@app/applications/Admin/Ui/RpcTelemetryPanel/AnomalyCallout';
import { CreditBreakdown } from '@app/applications/Admin/Ui/RpcTelemetryPanel/CreditBreakdown';
import { DailyTrend } from '@app/applications/Admin/Ui/RpcTelemetryPanel/DailyTrend';
import { LiveFeedTable } from '@app/applications/Admin/Ui/RpcTelemetryPanel/LiveFeedTable';
import { fmtAmount, shortAddr } from '@app/applications/Shared/Domain/formatters';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { Alert, Card, Skeleton, Spinner, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { type Key, useState } from 'react';

type Cadence = '2s' | '5s' | '15s' | 'off';

/** Poll cadence for /debug/rpc — a few seconds keeps the live feed fresh without hammering the BFF. */
const CADENCE_MS: Record<Cadence, number | false> = {
  '2s': 2_000,
  '5s': 5_000,
  '15s': 15_000,
  off: false,
};

const CADENCES: Cadence[] = ['2s', '5s', '15s', 'off'];

/** The owner's RPC/credit ops dashboard: budget headline, anomalies, spend breakdowns, live feed. */
export const RpcTelemetryPanel = () => {
  const [cadence, setCadence] = useState<Cadence>('5s');
  const { data, isPending, isError, isFetching, refetch } = useRpcTelemetry(CADENCE_MS[cadence]);

  const onCadenceChange = (keys: Iterable<Key>) => {
    const [first] = [...keys];
    if (typeof first === 'string' && first in CADENCE_MS) setCadence(first as Cadence);
  };

  const cadencePicker = (
    <div className="flex items-center gap-2">
      {isFetching && <Spinner size="sm" color="current" className="text-faint" />}
      <ToggleButtonGroup.Root
        size="sm"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[cadence]}
        onSelectionChange={onCadenceChange}
        aria-label="Refresh cadence"
      >
        {CADENCES.map((option) => (
          <ToggleButton.Root key={option} id={option}>
            {option}
          </ToggleButton.Root>
        ))}
      </ToggleButtonGroup.Root>
    </div>
  );

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton.Root className="h-28 w-full" />
        <Skeleton.Root className="h-16 w-full" />
        <Skeleton.Root className="h-64 w-full" />
      </div>
    );
  }

  // Keep showing the last good snapshot if a single poll fails; only show the error state when we have
  // nothing at all (the very first poll failed).
  if (!data) {
    return (
      <Card.Root>
        <Card.Content>
          <StateMessage
            variant="error"
            title="Could not load RPC telemetry."
            hint="The debug endpoint refused or is unreachable."
            onRetry={() => void refetch()}
          />
        </Card.Content>
      </Card.Root>
    );
  }

  const today = todayTotals(data.last7d, Date.now());
  const hasRollup = (data.last7d?.length ?? 0) > 0;
  // "Today" comes from the durable rollup when present; otherwise fall back to the session ledger.
  const creditsToday = hasRollup ? today.credits : data.stats.totalCredits;
  const callsToday = hasRollup ? today.calls : data.stats.totalCalls;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Credit budget</SectionLabel>
        {cadencePicker}
      </div>

      {isError && (
        <Alert.Root status="warning" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Live poll failing</Alert.Title>
            <Alert.Description>Showing the last snapshot that came through.</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Card.Root>
        <Card.Content className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <StatTile
            label={hasRollup ? 'Credits today' : 'Credits (session)'}
            value={fmtAmount(creditsToday)}
          />
          <StatTile
            label={hasRollup ? 'Calls today' : 'Calls (session)'}
            value={fmtAmount(callsToday)}
          />
          <StatTile label="Session credits" value={fmtAmount(data.stats.totalCredits)} />
          <StatTile
            label="Anomalies"
            value={data.anomalies.length}
            tone={data.anomalies.length > 0 ? 'loss' : 'neutral'}
          />
        </Card.Content>
      </Card.Root>

      <AnomalyCallout anomalies={data.anomalies} />

      <SectionLabel className="mt-2">Where the credits go</SectionLabel>
      <CreditBreakdown
        title="Credits by method"
        credits={data.stats.byMethod}
        weightOf={methodWeight}
        showLegend
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <CreditBreakdown title="Credits by code path" credits={data.stats.byCodePath} />
        <CreditBreakdown
          title="Credits by wallet"
          credits={data.stats.byWallet}
          labelOf={shortAddr}
        />
      </div>

      {hasRollup && <DailyTrend rows={data.last7d ?? []} />}

      <SectionLabel className="mt-2">Activity</SectionLabel>
      <LiveFeedTable entries={data.stats.ringTail} />
    </div>
  );
};
