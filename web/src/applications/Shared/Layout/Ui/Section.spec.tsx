import { Section } from '@app/applications/Shared/Layout/Ui/Section';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('Section', () => {
  it('names its region after its title, with its aside and actions on the title row', () => {
    renderWithProviders(
      <Section title="Open positions" aside="8" actions={<button type="button">Cards</button>}>
        <p>rows</p>
      </Section>,
    );

    const region = screen.getByRole('region', { name: 'Open positions' });
    expect(region).toHaveTextContent('Open positions8Cardsrows');
    expect(screen.getByRole('heading', { level: 2, name: 'Open positions' })).toBeInTheDocument();
  });
});
