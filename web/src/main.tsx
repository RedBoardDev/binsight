import '@app/core/theme/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html has no #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <main className="grid h-full place-items-center">
      <h1 className="font-semibold text-3xl text-accent">binsight</h1>
    </main>
  </StrictMode>,
);
