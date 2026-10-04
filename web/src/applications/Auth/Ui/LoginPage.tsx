import { LoginForm } from '@app/applications/Auth/Ui/LoginForm';
import { Card } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

interface LoginPageProps {
  destination: string | undefined;
}

export const LoginPage = ({ destination }: LoginPageProps) => {
  const { t } = useLingui();

  return (
    <main className="grid h-full place-items-center overflow-y-auto p-4">
      <Card className="w-full max-w-sm">
        <Card.Header>
          <h1 className="text-accent text-page-title">binsight</h1>
          <Card.Description>{t`Sign in with the password of this instance.`}</Card.Description>
        </Card.Header>
        <Card.Content>
          <LoginForm destination={destination} />
        </Card.Content>
      </Card>
    </main>
  );
};
