import type { LoginFormValues } from '@app/applications/Auth/Domain/loginForm';
import { passwordErrorMessage } from '@app/applications/Auth/Ui/LoginForm/errorCopy';
import { FieldError, Input, Label, TextField } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { type Control, Controller } from 'react-hook-form';

interface PasswordFieldProps {
  control: Control<LoginFormValues>;
}

export const PasswordField = ({ control }: PasswordFieldProps) => {
  const { i18n, t } = useLingui();

  return (
    <Controller
      control={control}
      name="password"
      render={({ field, fieldState }) => {
        const message = passwordErrorMessage(fieldState.error?.message);
        return (
          <TextField
            name={field.name}
            type="password"
            autoComplete="current-password"
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            isInvalid={fieldState.invalid}
            fullWidth
          >
            <Label>{t`Password`}</Label>
            <Input ref={field.ref} autoFocus />
            <FieldError>{message === null ? null : i18n._(message)}</FieldError>
          </TextField>
        );
      }}
    />
  );
};
