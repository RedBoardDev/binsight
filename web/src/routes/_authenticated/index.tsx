import { OverviewPage } from '@app/applications/Overview/Ui/OverviewPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/')({ component: OverviewPage });
