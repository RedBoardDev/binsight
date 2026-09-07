/** `value` as a percentage of `basis`, or 0 when there is no basis to divide by. */
export const pctOf = (value: number, basis: number): number =>
  basis > 0 ? (value / basis) * 100 : 0;
