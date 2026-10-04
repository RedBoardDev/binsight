import type { ReactNode } from 'react';

interface SettingRowProps {
  label: string;
  children: ReactNode;
}

export const SettingRow = ({ label, children }: SettingRowProps) => (
  <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
    <span className="font-medium text-body">{label}</span>
    {children}
  </div>
);
