'use client';

import type { RpcRingEntry } from '@app/applications/Admin/Domain/rpcTelemetry';
import { methodWeight } from '@app/applications/Admin/Domain/rpcTelemetry';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { Card, Chip, cn, Table } from '@heroui/react';
import { WEIGHT_METHOD_CLASS } from './creditWeightClass';

const feedTime = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString('en-US', { hour12: false });

interface LiveFeedTableProps {
  entries: RpcRingEntry[];
}

/** The meter's bounded ring, newest first — the ring tail arrives oldest→newest. */
export const LiveFeedTable = ({ entries }: LiveFeedTableProps) => {
  const rows = [...entries].reverse();

  return (
    <Card.Root>
      <Card.Header className="flex items-center justify-between gap-3">
        <Card.Title>Live feed</Card.Title>
        <span className="tabular text-faint text-xs">{rows.length} recent calls</span>
      </Card.Header>
      <Card.Content className="p-0">
        {rows.length === 0 ? (
          <StateMessage title="No calls recorded yet." />
        ) : (
          <Table.Root>
            <Table.ScrollContainer>
              <Table.Content aria-label="Recent RPC calls">
                <Table.Header>
                  <Table.Column isRowHeader>Time</Table.Column>
                  <Table.Column>Method</Table.Column>
                  <Table.Column>Code path</Table.Column>
                  <Table.Column>Wallet</Table.Column>
                  <Table.Column>Credits</Table.Column>
                  <Table.Column>Status</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((entry, index) => {
                    const weight = methodWeight(entry.method);
                    return (
                      <Table.Row
                        key={`${entry.at}:${index}`}
                        id={`${entry.at}:${index}`}
                        // A banned-method call (100-credit Enhanced) is the thing to spot — wash the
                        // whole row red.
                        className={cn(weight === 'banned' && 'bg-danger-soft')}
                      >
                        <Table.Cell className="tabular text-faint text-xs">
                          {feedTime(entry.at)}
                        </Table.Cell>
                        <Table.Cell className={cn('font-medium', WEIGHT_METHOD_CLASS[weight])}>
                          {entry.method}
                        </Table.Cell>
                        <Table.Cell className="text-muted text-xs">{entry.codePath}</Table.Cell>
                        <Table.Cell className="tabular text-muted text-xs">
                          {entry.wallet ? shortAddr(entry.wallet) : '—'}
                        </Table.Cell>
                        <Table.Cell className="tabular">{entry.credits}</Table.Cell>
                        <Table.Cell>
                          <Chip.Root
                            color={entry.ok ? 'success' : 'warning'}
                            variant="soft"
                            size="sm"
                          >
                            <Chip.Label>{entry.ok ? 'ok' : 'err'}</Chip.Label>
                          </Chip.Root>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table.Root>
        )}
      </Card.Content>
    </Card.Root>
  );
};
