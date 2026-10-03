import type { LoginFormError } from '@app/applications/Auth/Api/login';
import {
  apiErrorMessage,
  NETWORK_ERROR_MESSAGE,
} from '@app/applications/Shared/Ui/apiErrorMessages';
import { Alert } from '@heroui/react';
import { Plural, useLingui } from '@lingui/react/macro';

interface LoginFormAlertProps {
  error: LoginFormError;
}

const LoginFormErrorText = ({ error }: LoginFormAlertProps) => {
  const { i18n, t } = useLingui();

  switch (error.kind) {
    case 'too_many_attempts': {
      const seconds = error.retryAfterSeconds;
      return seconds === null ? (
        t`Too many failed attempts. Wait a moment and try again.`
      ) : (
        <Plural
          value={seconds}
          one="Too many failed attempts. Try again in # second."
          other="Too many failed attempts. Try again in # seconds."
        />
      );
    }
    case 'network':
      return i18n._(NETWORK_ERROR_MESSAGE);
    case 'api':
      return i18n._(apiErrorMessage(error.code));
  }
};

export const LoginFormAlert = ({ error }: LoginFormAlertProps) => (
  <Alert status="danger" role="alert">
    <Alert.Indicator />
    <Alert.Content>
      <Alert.Title>
        <LoginFormErrorText error={error} />
      </Alert.Title>
    </Alert.Content>
  </Alert>
);
