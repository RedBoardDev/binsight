import { requireSession } from '@app/applications/Auth/Api/useSession.api';
import { AppShell } from '@app/core/Layout/AppShell';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: AppShell,
});
