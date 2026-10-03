import { type LoginFormValues, loginFormSchema } from '@app/applications/Auth/Domain/loginForm';
import { Button, Form } from '@heroui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLingui } from '@lingui/react/macro';
import { useForm } from 'react-hook-form';
import { LoginFormAlert } from './LoginForm/LoginFormAlert';
import { PasswordField } from './LoginForm/PasswordField';
import { useLoginFormSubmit } from './LoginForm/useLoginFormSubmit';

interface LoginFormProps {
  destination: string | undefined;
}

export const LoginForm = ({ destination }: LoginFormProps) => {
  const { t } = useLingui();
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { password: '' },
  });
  const { submit, formError } = useLoginFormSubmit({ setError: form.setError, destination });

  return (
    <Form
      className="flex flex-col gap-4"
      validationBehavior="aria"
      onSubmit={(event) => void form.handleSubmit(submit)(event)}
    >
      {formError !== null && <LoginFormAlert error={formError} />}
      <PasswordField control={form.control} />
      <Button type="submit" size="lg" fullWidth isPending={form.formState.isSubmitting}>
        {t`Sign in`}
      </Button>
    </Form>
  );
};
