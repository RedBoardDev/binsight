import { HistoryPage } from '@app/applications/ClosedPosition/Ui/HistoryPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/history')({ component: HistoryPage });
