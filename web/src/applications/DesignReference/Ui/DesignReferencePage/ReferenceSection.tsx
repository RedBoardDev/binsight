import type { ReactNode } from 'react';

interface ReferenceSectionProps {
  title: string;
  children: ReactNode;
}

export const ReferenceSection = ({ title, children }: ReferenceSectionProps) => (
  <section className="flex flex-col gap-5">
    <h2 className="text-section">{title}</h2>
    {children}
  </section>
);
