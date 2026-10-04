import { TokenAvatar } from '@app/applications/Shared/Token/Ui/TokenAvatar';

interface TokenPairProps {
  base: string;
  quote: string;
}

export const TokenPair = ({ base, quote }: TokenPairProps) => (
  <span className="inline-flex min-w-0 items-center gap-2.5">
    <TokenAvatar symbol={base} />
    <span className="truncate font-semibold text-body">
      {base}
      <span className="text-muted">/{quote}</span>
    </span>
  </span>
);
