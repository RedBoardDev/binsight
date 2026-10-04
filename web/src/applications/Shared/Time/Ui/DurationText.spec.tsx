import { DurationText } from '@app/applications/Shared/Time/Ui/DurationText';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('DurationText', () => {
  it('writes a duration in the short form of the language', () => {
    renderWithProviders(<DurationText seconds={2 * 3_600 + 14 * 60} />);

    expect(screen.getByText('2h 14m')).toBeInTheDocument();
  });

  it('says less than a minute for a few seconds', () => {
    renderWithProviders(<DurationText seconds={20} />);

    expect(screen.getByText('<1m')).toBeInTheDocument();
  });
});
