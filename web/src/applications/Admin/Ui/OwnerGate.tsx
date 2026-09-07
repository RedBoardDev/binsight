'use client';

import { useIdentity } from '@app/applications/Authentication/Api/useIdentity.api';
import { Skeleton } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

interface OwnerGateProps {
  children: ReactNode;
}

/**
 * Owner-only shell for the admin surfaces. The backend re-checks `isOwner` on every call — this gate
 * is convenience (a non-owner never sees the shell), never security.
 */
export const OwnerGate = ({ children }: OwnerGateProps) => {
  const router = useRouter();
  const { data, isError } = useIdentity();

  useEffect(() => {
    if (isError) router.replace('/login');
    else if (data && !data.isOwner) router.replace('/');
  }, [data, isError, router]);

  if (data?.isOwner !== true) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8">
        <Skeleton.Root className="h-8 w-40" />
        <Skeleton.Root className="h-64 w-full" />
      </main>
    );
  }

  return <>{children}</>;
};
