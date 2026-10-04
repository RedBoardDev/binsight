import { SettingsPage } from '@app/applications/Setting/Ui/SettingsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/settings')({ component: SettingsPage });
