import { BrandMark } from '@app/core/Layout/BrandMark';
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <BrandMark size={40} withWordmark={false} />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display font-semibold text-lg text-foreground tracking-tight">
            Page not found
          </h1>
          <p className="text-muted text-sm">That link does not point anywhere in Binsight.</p>
        </div>
        <Link
          href="/"
          className="rounded-md bg-accent px-3.5 py-2 font-medium text-accent-foreground text-sm transition-[filter] hover:brightness-110"
        >
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
