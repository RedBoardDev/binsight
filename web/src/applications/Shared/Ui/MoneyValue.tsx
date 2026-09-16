'use client';

import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';

interface MoneyValueProps {
  value: number;
  signed?: boolean;
  decimals?: number;
  /**
   * The position's native quote symbol. Given anything other than SOL, the amount is rendered in that
   * unit and left out of the SOL⇄USD switch — a USDC figure has no SOL rate to convert through.
   */
  quoteSymbol?: string;
  /**
   * Show the ◎ unit mark. Off by default and on for hero figures only: the currency is stated once
   * at the top of a view (and in the currency toggle), so stamping a coloured glyph on every number
   * in a grid adds a third colour family fighting the P&L green/red for no information.
   */
  withGlyph?: boolean;
  glyphSize?: number;
}

/** An amount in the active display currency: SOL, or USD with its own "$". Masked when
 *  "hide amounts" is on. */
export const MoneyValue = ({
  value,
  signed,
  decimals,
  quoteSymbol,
  withGlyph = false,
  glyphSize = 13,
}: MoneyValueProps) => {
  const money = useMoney();
  // A non-SOL quote carries its own unit in the string, so the ◎ mark would contradict it.
  const nativeQuote = quoteSymbol != null && quoteSymbol !== 'SOL';
  const glyph = withGlyph && money.showGlyph && !nativeQuote;

  if (nativeQuote) return <>{money.quote(value, quoteSymbol, { signed, decimals })}</>;
  if (!glyph) return <>{money.sol(value, { signed, decimals })}</>;

  return (
    <span className="inline-flex items-center gap-1">
      {money.sol(value, { signed, decimals })}
      <SolMark size={glyphSize} />
    </span>
  );
};
