import { type ReactNode, useId } from 'react';

interface SectionProps {
  title: string;
  aside?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export const Section = ({ title, aside, actions, children }: SectionProps) => {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={titleId} className="text-section">
          {title}
        </h2>
        {aside !== undefined && <span className="text-meta text-faint">{aside}</span>}
        {actions !== undefined && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
};
