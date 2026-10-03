import { AppProviders } from '@app/core/AppProviders';
import { messages } from '@app/locales/en/messages.po';
import { i18n } from '@lingui/core';
import type { QueryClient } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createTestQueryClient } from './createTestQueryClient';

interface RenderOptions {
  readonly queryClient?: QueryClient;
}

export const renderWithProviders = (
  ui: ReactElement,
  { queryClient = createTestQueryClient() }: RenderOptions = {},
): RenderResult => {
  // Reset to English on every render: a test that switches the language must not leak it.
  i18n.loadAndActivate({ locale: 'en', messages });
  return render(<AppProviders queryClient={queryClient}>{ui}</AppProviders>);
};
