import { HealthPage } from '@app/applications/Health/Ui/HealthPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/health')({ component: HealthPage });
