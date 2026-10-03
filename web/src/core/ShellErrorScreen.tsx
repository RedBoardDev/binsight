import { ErrorScreen } from '@app/core/ErrorScreen';
import { Button } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

export const ShellErrorScreen = ({ error, reset }: ErrorComponentProps) => {
  const { t } = useLingui();
  const router = useRouter();

  useEffect(() => {
    console.error('a page failed to render', error);
  }, [error]);

  return (
    <ErrorScreen
      title={t`Something went wrong`}
      description={t`This page could not be displayed. Try again; if it keeps failing, reload the app.`}
      action={
        <Button
          size="lg"
          onPress={() => {
            reset();
            void router.invalidate();
          }}
        >
          {t`Try again`}
        </Button>
      }
    />
  );
};
