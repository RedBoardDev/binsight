const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

// "Equal jitter": half of the back-off is fixed, half is random, so clients cut off together do
// not all come back at the same instant, and none retries much sooner than the back-off.
export const reconnectDelay = (attempt: number, random: () => number): number =>
  Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** attempt) * (0.5 + random() / 2);
