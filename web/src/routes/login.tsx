import { leaveLoginWhenSignedIn } from '@app/applications/Auth/Api/sessionGuards';
import { LoginPage } from '@app/applications/Auth/Ui/LoginPage';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const loginSearchSchema = z.object({ redirect: z.string().optional().catch(undefined) });

const LoginRoute = () => {
  const { redirect } = Route.useSearch();
  return <LoginPage destination={redirect} />;
};

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  beforeLoad: ({ context, search }) => leaveLoginWhenSignedIn(context.queryClient, search.redirect),
  component: LoginRoute,
});
