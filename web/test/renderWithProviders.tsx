import { AppProviders } from '@app/core/AppProviders';
import { messages } from '@app/locales/en/messages.po';
import { i18n } from '@lingui/core';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';

export const renderWithProviders = (ui: ReactElement): RenderResult => {
  // Reset to English on every render: a test that switches the language must not leak it.
  i18n.loadAndActivate({ locale: 'en', messages });
  return render(<AppProviders>{ui}</AppProviders>);
};
