import { useAuthActions } from '@app/applications/Auth/Ui/useAuthActions';
import { useAsyncAction } from '@app/applications/Shared/Ui/useAsyncAction';
import { MORE_PAGES, SIGN_OUT } from '@app/core/Layout/AppShell/navItems';
import { Drawer, Label, ListBox } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

interface MoreSheetProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export const MoreSheet = ({ isOpen, onOpenChange }: MoreSheetProps) => {
  const { i18n, t } = useLingui();
  const { signOut } = useAuthActions();
  const { run: runSignOut } = useAsyncAction(signOut);

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog
          aria-label={t`More`}
          className="px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
        >
          <Drawer.Handle />
          <Drawer.Body className="px-0">
            <ListBox
              aria-label={t`More`}
              onAction={(key) => {
                onOpenChange(false);
                if (key === SIGN_OUT.key) {
                  runSignOut();
                }
              }}
            >
              <ListBox.Section aria-label={t`Pages`}>
                {MORE_PAGES.map(({ path, label, Icon }) => (
                  <ListBox.Item
                    key={path}
                    id={path}
                    href={path}
                    textValue={i18n._(label)}
                    className="min-h-12 gap-3 px-3 text-body"
                  >
                    <Icon aria-hidden strokeWidth={1.75} className="size-5 text-muted" />
                    <Label>{i18n._(label)}</Label>
                  </ListBox.Item>
                ))}
              </ListBox.Section>
              <ListBox.Section aria-label={t`Session`} className="mt-1 border-border border-t pt-1">
                <ListBox.Item
                  id={SIGN_OUT.key}
                  textValue={i18n._(SIGN_OUT.label)}
                  variant="danger"
                  className="min-h-12 gap-3 px-3 text-body"
                >
                  <SIGN_OUT.Icon aria-hidden strokeWidth={1.75} className="size-5" />
                  <Label>{i18n._(SIGN_OUT.label)}</Label>
                </ListBox.Item>
              </ListBox.Section>
            </ListBox>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
};
