import { useIsDesktop } from '@app/applications/Shared/Layout/Ui/useIsDesktop';
import { Drawer } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

interface ResponsiveDrawerProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  label: string;
  children: ReactNode;
}

export const ResponsiveDrawer = ({
  isOpen,
  onOpenChange,
  label,
  children,
}: ResponsiveDrawerProps) => {
  const { t } = useLingui();
  const isDesktop = useIsDesktop();

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement={isDesktop ? 'right' : 'bottom'}>
        <Drawer.Dialog
          aria-label={label}
          className={
            isDesktop
              ? 'w-160 max-w-[90vw] p-0 min-[90rem]:w-180'
              : 'h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] max-h-none p-0'
          }
        >
          {!isDesktop && <Drawer.Handle />}
          <Drawer.CloseTrigger aria-label={t`Close`} className="absolute top-3 right-3 z-10" />
          <Drawer.Body className="overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),1rem)] lg:px-8 lg:py-6">
            {children}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
};
