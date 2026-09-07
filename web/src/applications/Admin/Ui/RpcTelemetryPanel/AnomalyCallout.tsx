'use client';

import type { RpcAnomaly } from '@app/applications/Admin/Domain/rpcTelemetry';
import { severityTone } from '@app/applications/Admin/Domain/rpcTelemetry';
import { Alert, Chip } from '@heroui/react';
import type { ComponentProps } from 'react';

type ChipColor = ComponentProps<typeof Chip.Root>['color'];

const SEVERITY_CHIP: Record<ReturnType<typeof severityTone>, ChipColor> = {
  loss: 'danger',
  warn: 'warning',
  neutral: 'default',
};

interface AnomalyCalloutProps {
  anomalies: RpcAnomaly[];
}

/** The one thing an owner opens this page for: is anything burning credits it shouldn't be. */
export const AnomalyCallout = ({ anomalies }: AnomalyCalloutProps) => {
  if (anomalies.length === 0) {
    return (
      <Alert.Root status="success">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>No anomalies</Alert.Title>
          <Alert.Description>Credit usage is within budget.</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }

  const status = anomalies.some((a) => a.severity === 'high') ? 'danger' : 'warning';

  return (
    <Alert.Root status={status} role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>
          {anomalies.length} {anomalies.length === 1 ? 'anomaly' : 'anomalies'} active
        </Alert.Title>
        <ul className="mt-2 flex flex-col gap-1.5">
          {anomalies.map((anomaly) => (
            <li key={`${anomaly.kind}:${anomaly.detail}`} className="flex items-center gap-2">
              <Chip.Root
                color={SEVERITY_CHIP[severityTone(anomaly.severity)]}
                variant="soft"
                size="sm"
              >
                <Chip.Label>{anomaly.severity}</Chip.Label>
              </Chip.Root>
              <span className="font-medium text-sm">{anomaly.kind}</span>
              <span className="tabular truncate text-muted text-xs">{anomaly.detail}</span>
            </li>
          ))}
        </ul>
      </Alert.Content>
    </Alert.Root>
  );
};
