'use client';

import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';

interface MoneyValueProps {
  value: number;
  signed?: boolean;
  decimals?: number;
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
  withGlyph = false,
  glyphSize = 13,
}: MoneyValueProps) => {
  const money = useMoney();
  const glyph = withGlyph && money.showGlyph;

  if (!glyph) return <>{money.sol(value, { signed, decimals })}</>;

  return (
    <span className="inline-flex items-center gap-1">
      {money.sol(value, { signed, decimals })}
      <SolMark size={glyphSize} />
    </span>
  );
};
