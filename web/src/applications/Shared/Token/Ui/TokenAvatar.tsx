import { tokenInitials } from '@app/applications/Shared/Token/Domain/tokenInitials';
import { Avatar } from '@heroui/react';

interface TokenAvatarProps {
  symbol: string;
}

export const TokenAvatar = ({ symbol }: TokenAvatarProps) => (
  <Avatar aria-hidden size="sm" className="size-6 rounded-full bg-avatar">
    <Avatar.Fallback className="bg-avatar font-semibold text-avatar-foreground text-micro">
      {tokenInitials(symbol)}
    </Avatar.Fallback>
  </Avatar>
);
