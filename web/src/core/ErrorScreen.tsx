import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

interface ErrorScreenProps {
  title: string;
  description: string;
  action: ReactNode;
}

export const ErrorScreen = ({ title, description, action }: ErrorScreenProps) => (
  <div className="grid h-full place-content-center justify-items-center gap-4 p-6 text-center">
    <CircleAlert aria-hidden className="size-10 text-muted" />
    <h1 className="font-semibold text-xl">{title}</h1>
    <p className="max-w-md text-muted">{description}</p>
    {action}
  </div>
);
