import { toast } from '@app/applications/Shared/Ui/toast';
import { Button } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

const CONFIRMATION_MS = 1_200;

interface CopyButtonProps {
  value: string;
  label: string;
}

export const CopyButton = ({ value, label }: CopyButtonProps) => {
  const { t } = useLingui();
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    if (!hasCopied) {
      return undefined;
    }
    const timer = setTimeout(() => setHasCopied(false), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [hasCopied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setHasCopied(true);
      toast.success(t`Copied`);
    } catch {
      toast.danger(t`Copy failed: select the text and copy it.`);
    }
  };
  const Icon = hasCopied ? Check : Copy;

  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={label}
      onPress={() => void copy()}
      className="button--quiet"
    >
      <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
    </Button>
  );
};
