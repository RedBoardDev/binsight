import { useAsyncAction } from '@app/applications/Shared/Ui/useAsyncAction';
import { AlertDialog, Button } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  // Resolves true once done, and the dialog closes; false keeps it open, so the error the caller
  // shows stays next to the action that failed.
  onConfirm: () => Promise<boolean>;
}

export const ConfirmDialog = ({
  isOpen,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
}: ConfirmDialogProps) => {
  const { t } = useLingui();
  const { run, isPending } = useAsyncAction(async () => {
    if (await onConfirm()) {
      onOpenChange(false);
    }
  });

  return (
    <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <AlertDialog.Container>
        <AlertDialog.Dialog className="max-w-md">
          <AlertDialog.Header>
            <AlertDialog.Heading className="text-section">{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body className="text-body text-muted">{children}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="ghost">
              {t`Cancel`}
            </Button>
            <Button variant="danger" isPending={isPending} onPress={() => run()}>
              {confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
};
