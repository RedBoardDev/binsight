import { RealtimeStatusIndicator } from '@app/applications/Realtime/Ui/RealtimeStatusIndicator';
import { AccountMenu } from '@app/core/Layout/AppShell/AccountMenu';

// The right side of the top bar: the global controls, then the live status and the account menu.
export const TopBarControls = () => (
  <div className="ml-auto flex items-center gap-1 lg:gap-2">
    <RealtimeStatusIndicator />
    <AccountMenu />
  </div>
);
