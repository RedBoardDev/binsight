import { FigureSwap } from '@app/applications/Shared/Figure/Ui/FigureSwap';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const ENTRANCE_CLASS = 'starting:opacity-0';

describe('FigureSwap', () => {
  it('shows the first value without motion', () => {
    render(<FigureSwap value="1">1</FigureSwap>);

    expect(screen.getByText('1')).not.toHaveClass(ENTRANCE_CLASS);
  });

  it('marks every change, back to the first value too', () => {
    const { rerender } = render(<FigureSwap value="1">1</FigureSwap>);
    rerender(<FigureSwap value="2">2</FigureSwap>);
    expect(screen.getByText('2')).toHaveClass(ENTRANCE_CLASS);

    rerender(<FigureSwap value="1">1</FigureSwap>);

    expect(screen.getByText('1')).toHaveClass(ENTRANCE_CLASS);
  });
});
