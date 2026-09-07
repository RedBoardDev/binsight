'use client';

import { useAdminWallets } from '@app/applications/Admin/Api/useAdmin.api';
import { fmtRelative, shortAddr } from '@app/applications/Shared/Domain/formatters';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { Card, Chip, Skeleton, Table } from '@heroui/react';

/** Every monitored wallet with its ingest status — monitoring is shared, so one row can serve
 *  several accounts (`watchers`). */
export const AdminWalletsPanel = () => {
  const { data, isPending, isError, refetch } = useAdminWallets();

  const rows = data ?? [];
  const now = Date.now();

  return (
    <Card.Root>
      <Card.Header className="flex items-center justify-between gap-3">
        <Card.Title>Monitored wallets</Card.Title>
        <span className="tabular text-faint text-xs">{rows.length}</span>
      </Card.Header>

      <Card.Content className="p-0">
        {isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton.Root key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : isError ? (
          <StateMessage
            variant="error"
            title="Could not load wallets."
            hint="The admin API refused or is unreachable."
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          <StateMessage
            title="No monitored wallets yet."
            hint="A wallet appears here as soon as an account watches it."
          />
        ) : (
          <Table.Root>
            <Table.ScrollContainer>
              <Table.Content aria-label="Monitored wallets">
                <Table.Header>
                  <Table.Column isRowHeader>Wallet</Table.Column>
                  <Table.Column>Status</Table.Column>
                  <Table.Column>Watchers</Table.Column>
                  <Table.Column>Open</Table.Column>
                  <Table.Column>Closed</Table.Column>
                  <Table.Column>Last sync</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((wallet) => (
                    <Table.Row key={wallet.address} id={wallet.address}>
                      <Table.Cell className="tabular text-xs">
                        {shortAddr(wallet.address, 6, 6)}
                      </Table.Cell>
                      <Table.Cell>
                        {wallet.ready === false ? (
                          <Chip.Root color="warning" variant="soft" size="sm">
                            <Chip.Label>indexing… ({wallet.indexedTxs ?? 0} txs)</Chip.Label>
                          </Chip.Root>
                        ) : (
                          <Chip.Root color="success" variant="soft" size="sm">
                            <Chip.Label>ready</Chip.Label>
                          </Chip.Root>
                        )}
                      </Table.Cell>
                      <Table.Cell className="tabular">{wallet.watchers}</Table.Cell>
                      <Table.Cell className="tabular">{wallet.openPositions}</Table.Cell>
                      <Table.Cell className="tabular">{wallet.closedPositions}</Table.Cell>
                      <Table.Cell className="tabular text-muted text-xs">
                        {wallet.lastUpdate === null ? 'never' : fmtRelative(wallet.lastUpdate, now)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table.Root>
        )}
      </Card.Content>
    </Card.Root>
  );
};
