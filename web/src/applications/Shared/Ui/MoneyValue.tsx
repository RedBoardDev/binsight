'use client';

import { useMoney } from '@app/applications/Shared/Ui/useMoney';

interface MoneyValueProps {
  value: number;
  signed?: boolean;
  /**
   * The position's native quote symbol. Given anything other than SOL, the amount is rendered in that
   * unit and left out of the SOL⇄USD switch — a USDC figure has no SOL rate to convert through.
   */
  quoteSymbol?: string;
}

/** An amount in the active display currency: SOL, or USD with its own "$". Masked when
 *  "hide amounts" is on. No ◎ mark: the currency is stated once at the top of a view (and in the
 *  currency toggle), so stamping a glyph on every number in a grid only fights the P&L colours. */
export const MoneyValue = ({ value, signed, quoteSymbol = 'SOL' }: MoneyValueProps) => {
  const money = useMoney();
  return <>{money.quote(value, quoteSymbol, { signed })}</>;
};
