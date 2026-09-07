import { Dashboard } from '@app/core/Layout/Dashboard';
import { API_URL, SESSION_COOKIE } from '@app/lib/apiConfig';
import { getOpenAccess } from '@app/lib/appConfig';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function Home() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) redirect('/login');
  // Gate on a VALID token (signature + expiry), not just cookie presence — the backend verifies it.
  const res = await fetch(`${API_URL}/auth/verify`, {
    headers: { authorization: `Bearer ${session}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) redirect('/login');
  return <Dashboard openAccess={await getOpenAccess()} />;
}
