import { useAuthActions } from '@app/applications/Auth/Ui/useAuthActions';
import { useAsyncAction } from '@app/applications/Shared/Ui/useAsyncAction';
import { Button } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { LogOut } from 'lucide-react';

export const SignOutButton = () => {
  const { t } = useLingui();
  const { signOut } = useAuthActions();
  const { run, isPending } = useAsyncAction(signOut);

  return (
    <Button variant="ghost" isPending={isPending} onPress={() => run()}>
      <LogOut aria-hidden strokeWidth={1.75} className="size-4" />
      {t`Sign out`}
    </Button>
  );
};
