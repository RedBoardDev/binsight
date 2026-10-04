import { StatsPage } from '@app/applications/Stats/Ui/StatsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/stats')({ component: StatsPage });
