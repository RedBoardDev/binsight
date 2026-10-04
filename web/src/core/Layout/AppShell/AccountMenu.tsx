import { useAuthActions } from '@app/applications/Auth/Ui/useAuthActions';
import { useAsyncAction } from '@app/applications/Shared/Ui/useAsyncAction';
import { ACCOUNT_MENU_PAGES, SIGN_OUT } from '@app/core/Layout/AppShell/navItems';
import { Button, Dropdown, Label, Separator } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { Settings } from 'lucide-react';

export const AccountMenu = () => {
  const { i18n, t } = useLingui();
  const { signOut } = useAuthActions();
  const { run: runSignOut, isPending } = useAsyncAction(signOut);

  return (
    <Dropdown>
      <Button
        isIconOnly
        variant="ghost"
        aria-label={t`Settings and session`}
        isPending={isPending}
        className="button--chrome"
      >
        <Settings aria-hidden strokeWidth={1.75} className="size-4.5" />
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-52">
        <Dropdown.Menu
          aria-label={t`Settings and session`}
          onAction={(key) => {
            if (key === SIGN_OUT.key) {
              runSignOut();
            }
          }}
        >
          {ACCOUNT_MENU_PAGES.map(({ path, label, Icon }) => (
            <Dropdown.Item key={path} id={path} href={path} textValue={i18n._(label)}>
              <Icon aria-hidden strokeWidth={1.75} className="size-4 text-muted" />
              <Label>{i18n._(label)}</Label>
            </Dropdown.Item>
          ))}
          <Separator />
          <Dropdown.Item id={SIGN_OUT.key} textValue={i18n._(SIGN_OUT.label)} variant="danger">
            <SIGN_OUT.Icon aria-hidden strokeWidth={1.75} className="size-4" />
            <Label>{i18n._(SIGN_OUT.label)}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
};
