import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  children: ReactNode;
}

export const SettingsSection = ({ title, children }: SettingsSectionProps) => (
  <section className="flex flex-col">
    <h2 className="mb-1 text-section">{title}</h2>
    <div className="flex flex-col divide-y divide-border-subtle">{children}</div>
  </section>
);
