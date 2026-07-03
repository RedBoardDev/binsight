'use client';

import type { ReactNode } from 'react';

/**
 * Shared centered-card layout for the pre-app screens (login, invite gate, welcome): the brand
 * mark + a title/subtitle header over the screen's own content. Matches the historical login card
 * so the auth flow stays visually consistent with the rest of the app.
 */
export function AuthScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-pop sm:p-8">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          {/* biome-ignore lint/performance/noImgElement: tiny static brand mark, no layout cost */}
          <img src="/icon.svg" alt="" width={56} height={56} className="size-14 rounded-2xl" />
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-lg text-text tracking-tight">{title}</h1>
            <p className="text-muted text-sm">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
