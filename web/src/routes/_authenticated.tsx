import { requireSession } from '@app/applications/Auth/Api/sessionGuards';
import { scopeRouteOptions } from '@app/applications/Shared/Scope/Ui/scopeRouteOptions';
import { AppShell } from '@app/core/Layout/AppShell';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated')({
  ...scopeRouteOptions,
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: AppShell,
});
