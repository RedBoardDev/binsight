import { PageHeader } from '@app/applications/Shared/Layout/Ui/PageHeader';
import { AmountsSection } from './DesignReferencePage/AmountsSection';
import { ColorsSection } from './DesignReferencePage/ColorsSection';
import { ControlsSection } from './DesignReferencePage/ControlsSection';
import { MaterialsSection } from './DesignReferencePage/MaterialsSection';
import { MotionSection } from './DesignReferencePage/MotionSection';
import { TypographySection } from './DesignReferencePage/TypographySection';

// The design system on one page, for development and review: tokens, type, amounts, controls,
// materials and motion, before the pages that use them exist. A developer's reference that an
// owner never sees, so its text is not translated.
export const DesignReferencePage = () => (
  <>
    <PageHeader title="Design reference" />
    <div className="flex flex-col gap-16">
      <AmountsSection />
      <ColorsSection />
      <TypographySection />
      <ControlsSection />
      <MaterialsSection />
      <MotionSection />
    </div>
  </>
);
