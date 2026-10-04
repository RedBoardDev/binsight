import { SOLANA_MARK_ID } from '@app/applications/Shared/Unit/Ui/SolanaMarkDefs';

export type SolanaMarkSize = 'amount' | 'column-header' | 'hero';

const SIZE_CLASSES: Record<SolanaMarkSize, string> = {
  amount: 'size-[0.8em]',
  'column-header': 'size-[0.95em]',
  hero: 'size-[0.44em]',
};

interface SolanaMarkProps {
  size?: SolanaMarkSize;
}

export const SolanaMark = ({ size = 'amount' }: SolanaMarkProps) => (
  <svg aria-hidden viewBox="0 0 20 20" className={`inline-block shrink-0 ${SIZE_CLASSES[size]}`}>
    <use href={`#${SOLANA_MARK_ID}`} />
  </svg>
);
