import { type LoginFormError, login } from '@app/applications/Auth/Api/login';
import { sessionQuery } from '@app/applications/Auth/Api/sessionQuery';
import type { LoginFormValues } from '@app/applications/Auth/Domain/loginForm';
import { safeRedirect } from '@app/applications/Auth/Domain/safeRedirect';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { UseFormSetError } from 'react-hook-form';

interface LoginFormSubmitOptions {
  readonly setError: UseFormSetError<LoginFormValues>;
  readonly destination: string | undefined;
}

interface LoginFormSubmit {
  readonly submit: (values: LoginFormValues) => Promise<boolean>;
  readonly formError: LoginFormError | null;
}

export const useLoginFormSubmit = ({
  setError,
  destination,
}: LoginFormSubmitOptions): LoginFormSubmit => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<LoginFormError | null>(null);

  const submit = async (values: LoginFormValues): Promise<boolean> => {
    setFormError(null);
    const result = await login(values);
    if (result.status === 'success') {
      queryClient.setQueryData(sessionQuery.queryKey, result.session);
      await navigate({ href: safeRedirect(destination) });
      return true;
    }
    if ('fieldErrors' in result) {
      setError(
        'password',
        { type: 'server', message: result.fieldErrors.password },
        { shouldFocus: true },
      );
    } else {
      setFormError(result.formError);
    }
    return false;
  };

  return { submit, formError };
};
