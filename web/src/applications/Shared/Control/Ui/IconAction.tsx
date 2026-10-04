import { Button, Tooltip } from '@heroui/react';
import type { LucideIcon } from 'lucide-react';

const TOOLTIP_DELAY_MS = 400;

interface IconActionProps {
  label: string;
  Icon: LucideIcon;
  onPress: () => void;
}

export const IconAction = ({ label, Icon, onPress }: IconActionProps) => (
  <Tooltip delay={TOOLTIP_DELAY_MS}>
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={label}
      onPress={onPress}
      className="button--quiet"
    >
      <Icon aria-hidden strokeWidth={1.75} className="size-4" />
    </Button>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip>
);
