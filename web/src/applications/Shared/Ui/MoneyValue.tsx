'use client';

import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';

interface MoneyValueProps {
  value: number;
  signed?: boolean;
  decimals?: number;
  glyphSize?: number;
}

/** An amount in the active display currency: SOL with the ◎ mark, or USD. Masked when
 *  "hide amounts" is on. */
export const MoneyValue = ({ value, signed, decimals, glyphSize = 13 }: MoneyValueProps) => {
  const money = useMoney();
  return (
    <span className="inline-flex items-center gap-1">
      {money.sol(value, { signed, decimals })}
      {money.showGlyph && <SolMark size={glyphSize} />}
    </span>
  );
};
