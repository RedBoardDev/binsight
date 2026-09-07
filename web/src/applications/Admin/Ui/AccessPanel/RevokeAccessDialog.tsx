'use client';

import { useAccessMutations } from '@app/applications/Admin/Api/useAdmin.api';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import type { AccessEntry } from '@binsight/shared';
import { Alert, Button, Modal, Spinner, useOverlayState } from '@heroui/react';
import { useState } from 'react';

interface RevokeAccessDialogProps {
  entry: AccessEntry | null;
  onClose: () => void;
}

/** Destructive confirm for both shapes of removal: a joined account loses its login, an invite only
 *  loses its right to register. */
export const RevokeAccessDialog = ({ entry, onClose }: RevokeAccessDialogProps) => {
  const { revoke } = useAccessMutations();
  const [error, setError] = useState<string | null>(null);

  const state = useOverlayState({
    isOpen: entry !== null,
    onOpenChange: (open) => {
      if (!open) {
        setError(null);
        onClose();
      }
    },
  });

  const joined = entry?.status === 'joined';
  const label = joined ? 'Revoke access' : 'Remove invite';

  const onConfirm = async () => {
    if (!entry || revoke.isPending) return;
    setError(null);
    try {
      const ok = await revoke.mutateAsync(entry.address);
      if (ok) {
        onClose();
        return;
      }
      setError('Could not revoke.');
    } catch {
      setError('Could not revoke — the request failed.');
    }
  };

  return (
    <Modal.Root state={state}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{joined ? 'Revoke account access' : 'Remove invite'}</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="text-muted text-sm leading-relaxed">
                {entry === null
                  ? null
                  : joined
                    ? `Delete the account for ${shortAddr(entry.address)} and remove its invite. They lose access immediately and can't re-register. Their watched wallets' data is kept (shared) — only live monitoring of wallets nobody else watches stops.`
                    : `Remove the invite for ${shortAddr(entry.address)}. This wallet won't be able to register.`}
              </p>
              {error !== null && (
                <Alert.Root status="danger" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert.Root>
              )}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" onPress={onClose}>
                Cancel
              </Button>
              <Button
                variant="danger"
                isDisabled={revoke.isPending}
                onPress={() => void onConfirm()}
              >
                {revoke.isPending && <Spinner size="sm" color="current" />}
                {label}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
};
