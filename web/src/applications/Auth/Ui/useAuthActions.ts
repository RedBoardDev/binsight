import { logout } from '@app/applications/Auth/Api/logout';
import {
  apiErrorMessage,
  NETWORK_ERROR_MESSAGE,
} from '@app/applications/Shared/Ui/apiErrorMessages';
import { toast } from '@app/applications/Shared/Ui/toast';
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

interface AuthActions {
  readonly signOut: () => Promise<boolean>;
}

export const useAuthActions = (): AuthActions => {
  const { i18n, t } = useLingui();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // The session cookie is HttpOnly: only the server can delete it. If the call fails, the owner
  // is still signed in, so the app says so instead of pretending to sign out.
  const signOut = async (): Promise<boolean> => {
    const result = await logout();
    if (result.status === 'error') {
      const reason =
        result.formError.kind === 'network'
          ? NETWORK_ERROR_MESSAGE
          : apiErrorMessage(result.formError.code);
      toast.danger(t`Could not sign out.`, { description: i18n._(reason) });
      return false;
    }
    queryClient.clear();
    await navigate({ to: '/login' });
    return true;
  };

  return { signOut };
};
