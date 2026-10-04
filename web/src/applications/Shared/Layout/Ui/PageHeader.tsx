import { type ReactNode, useEffect } from 'react';

const APP_NAME = 'binsight';

interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

// The page's only h1. It takes the focus after a navigation (AppShell), and names the browser tab.
export const PageHeader = ({ title, children }: PageHeaderProps) => {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);

  return (
    <header className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-3 lg:mb-10">
      <h1 tabIndex={-1} className="text-key outline-none lg:text-page-title">
        {title}
      </h1>
      {children !== undefined && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </header>
  );
};
