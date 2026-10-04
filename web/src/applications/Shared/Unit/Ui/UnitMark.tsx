import type { MoneyUnit } from '@app/applications/Shared/Figure/Domain/figure';
import { SolanaMark, type SolanaMarkSize } from '@app/applications/Shared/Unit/Ui/SolanaMark';

const STABLECOIN_TICKERS = { usdc: 'USDC', usdt: 'USDT' } as const;

interface UnitMarkProps {
  unit: MoneyUnit;
  size?: SolanaMarkSize;
}

// The unit after a figure: the Solana mark for SOL, the ticker for a stablecoin, nothing for
// dollars (the "$" is part of the formatted figure).
export const UnitMark = ({ unit, size = 'amount' }: UnitMarkProps) => {
  switch (unit) {
    case 'sol':
      return <SolanaMark size={size} />;
    case 'usd':
      return null;
    case 'usdc':
    case 'usdt':
      return <span className="text-faint">{STABLECOIN_TICKERS[unit]}</span>;
  }
};
