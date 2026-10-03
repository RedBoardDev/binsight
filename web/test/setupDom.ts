import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Without Vitest globals, Testing Library cannot register its own cleanup: rendered trees would
// leak from one test into the next.
afterEach(() => {
  cleanup();
});
