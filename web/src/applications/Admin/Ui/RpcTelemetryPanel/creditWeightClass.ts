import type { CreditWeight } from '@app/applications/Admin/Domain/rpcTelemetry';

/** Bar fill by credit weight — banned (red) and heavy (amber) make a costly call pop instantly.
 *  `normal` stays neutral: the cyan accent is reserved for chrome, never for a data mark. */
export const BAR_FILL_CLASS: Record<CreditWeight, string> = {
  banned: 'bg-danger',
  heavy: 'bg-warning',
  normal: 'bg-muted',
};

/** Breakdown-label colour by weight (normal = muted, secondary to the bar). */
export const WEIGHT_LABEL_CLASS: Record<CreditWeight, string> = {
  banned: 'text-danger',
  heavy: 'text-warning',
  normal: 'text-muted',
};

/** Live-feed method colour by weight (normal = full-strength text). */
export const WEIGHT_METHOD_CLASS: Record<CreditWeight, string> = {
  banned: 'text-danger',
  heavy: 'text-warning',
  normal: 'text-foreground',
};
