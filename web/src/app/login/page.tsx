import { AuthCard } from '@app/applications/Authentication/Ui/AuthCard';
import { getOpenAccess } from '@app/lib/appConfig';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  // Read open-access from the backend server-side so the signup UI is correct on first paint (no flash
  // between the SIWS flow and the simplified address + password form).
  const openAccess = await getOpenAccess();
  return <AuthCard openAccess={openAccess} />;
}
