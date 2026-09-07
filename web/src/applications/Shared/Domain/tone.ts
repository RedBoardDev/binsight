export type Tone = 'profit' | 'loss' | 'neutral';

/** The single source of truth for mapping a signed value to a profit/loss/neutral tone. */
export const toneOf = (value: number): Tone =>
  value > 0 ? 'profit' : value < 0 ? 'loss' : 'neutral';

export const toneTextClass: Record<Tone, string> = {
  profit: 'text-success',
  loss: 'text-danger',
  neutral: 'text-foreground',
};

export const toneDotClass: Record<Tone, string> = {
  profit: 'bg-success',
  loss: 'bg-danger',
  neutral: 'bg-muted',
};
