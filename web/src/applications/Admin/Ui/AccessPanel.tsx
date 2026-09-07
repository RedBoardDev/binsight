'use client';

import { useAccessEntries } from '@app/applications/Admin/Api/useAdmin.api';
import { InviteWalletModal } from '@app/applications/Admin/Ui/AccessPanel/InviteWalletModal';
import { RevokeAccessDialog } from '@app/applications/Admin/Ui/AccessPanel/RevokeAccessDialog';
import { fmtDateFull } from '@app/applications/Shared/Domain/formatters';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import type { AccessEntry } from '@binsight/shared';
import { Button, Card, Chip, Skeleton, Table, useOverlayState } from '@heroui/react';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';

/** Invited (whitelisted) plus joined (registered) accounts, with the invite and revoke actions. */
export const AccessPanel = () => {
  const { data, isPending, isError, refetch } = useAccessEntries();
  const inviteState = useOverlayState();
  const [pendingRevoke, setPendingRevoke] = useState<AccessEntry | null>(null);

  const rows = data ?? [];

  return (
    <Card.Root>
      <Card.Header className="flex items-center justify-between gap-3">
        <Card.Title>Access</Card.Title>
        <Button variant="secondary" size="sm" onPress={inviteState.open}>
          <UserPlus size={14} />
          Invite wallet
        </Button>
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
            title="Could not load the access list."
            hint="The admin API refused or is unreachable."
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          <StateMessage
            title="No accounts or invites yet."
            hint="Invite a wallet to let it register."
          />
        ) : (
          <Table.Root>
            <Table.ScrollContainer>
              <Table.Content aria-label="Accounts and invites">
                <Table.Header>
                  <Table.Column isRowHeader>Wallet</Table.Column>
                  <Table.Column>Status</Table.Column>
                  <Table.Column>Wallets</Table.Column>
                  <Table.Column>Added</Table.Column>
                  <Table.Column>Note</Table.Column>
                  <Table.Column>Actions</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((entry) => (
                    <Table.Row key={entry.address} id={entry.address}>
                      <Table.Cell>
                        <span className="flex items-center gap-2">
                          <span className="tabular text-xs">{entry.address}</span>
                          {entry.isOwner && (
                            <Chip.Root color="accent" variant="soft" size="sm">
                              <Chip.Label>owner</Chip.Label>
                            </Chip.Root>
                          )}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip.Root
                          color={entry.status === 'joined' ? 'success' : 'warning'}
                          variant="soft"
                          size="sm"
                        >
                          <Chip.Label>{entry.status}</Chip.Label>
                        </Chip.Root>
                      </Table.Cell>
                      <Table.Cell className="tabular">
                        {entry.status === 'joined' ? entry.wallets.length : '—'}
                      </Table.Cell>
                      <Table.Cell className="tabular text-muted text-xs">
                        {fmtDateFull(entry.createdAt)}
                      </Table.Cell>
                      <Table.Cell className="max-w-40 truncate text-muted text-xs">
                        {entry.note || '—'}
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        {entry.isOwner ? (
                          <span className="text-faint text-xs">—</span>
                        ) : (
                          <Button
                            variant="danger-soft"
                            size="sm"
                            onPress={() => setPendingRevoke(entry)}
                          >
                            {entry.status === 'joined' ? 'Revoke' : 'Remove'}
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table.Root>
        )}
      </Card.Content>

      <InviteWalletModal state={inviteState} />
      <RevokeAccessDialog entry={pendingRevoke} onClose={() => setPendingRevoke(null)} />
    </Card.Root>
  );
};
