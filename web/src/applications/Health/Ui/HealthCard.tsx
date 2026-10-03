import { useHealth } from '@app/applications/Health/Api/useHealth.api';
import { HealthReport } from '@app/applications/Health/Ui/HealthCard/HealthReport';
import { Alert, Button, Card, Skeleton } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

const HealthCardBody = () => {
  const { t } = useLingui();
  const health = useHealth();

  if (health.isPending) {
    return <Skeleton className="h-28 rounded-lg" />;
  }
  if (health.isError) {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{t`The server health could not be read.`}</Alert.Title>
        </Alert.Content>
        <Button size="sm" variant="secondary" onPress={() => void health.refetch()}>
          {t`Try again`}
        </Button>
      </Alert>
    );
  }
  return <HealthReport health={health.data} />;
};

export const HealthCard = () => {
  const { t } = useLingui();

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t`Server`}</Card.Title>
      </Card.Header>
      <Card.Content>
        <HealthCardBody />
      </Card.Content>
    </Card>
  );
};
