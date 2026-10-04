import { useIsDesktop } from '@app/applications/Shared/Layout/Ui/useIsDesktop';
import { Drawer, Modal } from '@heroui/react';
import type { ReactNode } from 'react';

interface ResponsiveDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  children: ReactNode;
}

export const ResponsiveDialog = ({
  isOpen,
  onOpenChange,
  title,
  children,
}: ResponsiveDialogProps) => {
  const isDesktop = useIsDesktop();

  if (!isDesktop) {
    return (
      <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Content placement="bottom">
          <Drawer.Dialog className="px-4 pt-2 pb-[max(env(safe-area-inset-bottom),1rem)]">
            <Drawer.Handle />
            <Drawer.Header>
              <Drawer.Heading className="text-section">{title}</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="px-0">{children}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    );
  }
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="max-w-lg">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading className="text-section">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
};
