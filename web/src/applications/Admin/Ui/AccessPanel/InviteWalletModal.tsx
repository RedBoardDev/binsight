'use client';

import { useAccessMutations } from '@app/applications/Admin/Api/useAdmin.api';
import { isSolanaAddress } from '@app/applications/Shared/Domain/solanaAddress';
import {
  Alert,
  Button,
  FieldError,
  Form,
  Input,
  Label,
  Modal,
  Spinner,
  TextField,
  type UseOverlayStateReturn,
} from '@heroui/react';
import { type FormEvent, useState } from 'react';

interface InviteWalletModalProps {
  state: UseOverlayStateReturn;
}

/** Adds a wallet to the allowlist so it can register. Owner only — the backend re-checks. */
export const InviteWalletModal = ({ state }: InviteWalletModalProps) => {
  const { invite } = useAccessMutations();
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = address.trim();
  const addressOk = isSolanaAddress(trimmed);

  const close = () => {
    setAddress('');
    setNote('');
    setError(null);
    state.close();
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!addressOk || invite.isPending) return;
    setError(null);
    try {
      const ok = await invite.mutateAsync({ address: trimmed, note: note.trim() });
      if (ok) close();
      else setError('Could not invite — check the address.');
    } catch {
      setError('Could not invite — the request failed.');
    }
  };

  return (
    <Modal.Root state={state}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Invite a wallet</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Form onSubmit={(event) => void onSubmit(event)}>
              <Modal.Body className="flex flex-col gap-4">
                <TextField.Root
                  value={address}
                  onChange={setAddress}
                  isInvalid={address.length > 0 && !addressOk}
                  autoFocus
                  name="address"
                  className="flex flex-col gap-1.5"
                >
                  <Label>Wallet address</Label>
                  <Input
                    placeholder="Solana address"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="tabular h-11 text-base"
                  />
                  <FieldError>That doesn’t look like a Solana address.</FieldError>
                </TextField.Root>

                <TextField.Root
                  value={note}
                  onChange={setNote}
                  name="note"
                  className="flex flex-col gap-1.5"
                >
                  <Label>Note</Label>
                  <Input placeholder="Optional — who is this?" className="h-11 text-base" />
                </TextField.Root>

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
                <Button variant="ghost" onPress={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" isDisabled={!addressOk || invite.isPending}>
                  {invite.isPending && <Spinner size="sm" color="current" />}
                  Invite
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
};
