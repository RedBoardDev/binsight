'use client';

import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { useCopy } from '@app/applications/Shared/Ui/useCopy';
import { Button } from '@heroui/react';
import { ArrowLeft, Check, Copy, ShieldAlert } from 'lucide-react';

interface NotApprovedNoticeProps {
  address: string;
  onBack: () => void;
}

/** Private beta: the wallet signed fine but is not on the allowlist. Its own screen because the fix
 *  is social (ask the owner), not a retry of the form. */
export const NotApprovedNotice = ({ address, onBack }: NotApprovedNoticeProps) => {
  const { copied, copy } = useCopy();

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-warning-soft text-warning">
        <ShieldAlert size={18} />
      </span>
      <p className="font-medium text-foreground text-sm">This wallet isn’t approved yet.</p>
      <p className="max-w-xs text-faint text-xs leading-relaxed">
        The app is in private beta. Ask the owner to add{' '}
        <span className="tabular text-muted">{shortAddr(address, 6, 6)}</span> to the allowlist,
        then come back to create your account.
      </p>
      <Button variant="secondary" size="sm" onPress={() => void copy(address)}>
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {copied ? 'Address copied' : 'Copy full address'}
      </Button>
      <Button variant="ghost" size="sm" onPress={onBack}>
        <ArrowLeft size={14} />
        Back to sign in
      </Button>
    </div>
  );
};
