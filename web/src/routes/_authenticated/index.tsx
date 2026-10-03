import { DashboardPage } from '@app/applications/Dashboard/Ui/DashboardPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/')({ component: DashboardPage });
