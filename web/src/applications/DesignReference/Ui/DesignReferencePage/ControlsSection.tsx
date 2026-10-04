import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';
import { ReduceMotionSwitch } from '@app/applications/Shared/Motion/Ui/ReduceMotionSwitch';
import { CurrencyToggle } from '@app/applications/Shared/Preference/Ui/CurrencyToggle';
import { HideAmountsToggle } from '@app/applications/Shared/Preference/Ui/HideAmountsToggle';
import { PeriodPills } from '@app/applications/Shared/Scope/Ui/PeriodPills';
import { ThemeSwitcher } from '@app/core/theme/ThemeSwitcher';
import { Button, Tooltip } from '@heroui/react';
import { Share2 } from 'lucide-react';

export const ControlsSection = () => (
  <ReferenceSection title="Controls">
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">Copy image</Button>
      <Button variant="secondary">Retry</Button>
      <Button variant="ghost">Export CSV</Button>
      <Button variant="danger-soft">Remove wallet</Button>
      <Tooltip delay={0}>
        <Button isIconOnly variant="ghost" aria-label="Share" className="text-muted">
          <Share2 aria-hidden strokeWidth={1.75} className="size-4" />
        </Button>
        <Tooltip.Content>Share</Tooltip.Content>
      </Tooltip>
    </div>
    <div className="flex flex-wrap items-center gap-4">
      <CurrencyToggle />
      <HideAmountsToggle />
      <ThemeSwitcher />
      <PeriodPills />
    </div>
    <div className="max-w-md">
      <ReduceMotionSwitch />
    </div>
  </ReferenceSection>
);
