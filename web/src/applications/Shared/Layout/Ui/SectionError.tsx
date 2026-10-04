import { Button } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

interface SectionErrorProps {
  message: string;
  onRetry: () => void;
}

export const SectionError = ({ message, onRetry }: SectionErrorProps) => {
  const { t } = useLingui();

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-6 text-body text-muted"
    >
      <span>{message}</span>
      <Button variant="ghost" size="sm" onPress={onRetry} className="button--inline-action">
        {t`Retry`}
      </Button>
    </div>
  );
};
