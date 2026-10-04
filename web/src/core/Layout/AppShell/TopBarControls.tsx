import { CurrencyToggle } from '@app/applications/Shared/Preference/Ui/CurrencyToggle';
import { HideAmountsToggle } from '@app/applications/Shared/Preference/Ui/HideAmountsToggle';

// The global display controls, at the right of the top bar on every size: the currency of every
// amount, and the switch that hides them. On a phone they close the row: the eye's touch target
// reaches into the margin, so that the icon itself lines up with the page edge as the brand does.
export const TopBarControls = () => (
  <div className="-mr-3 ml-auto flex items-center gap-1 lg:mr-0 lg:gap-2">
    <CurrencyToggle />
    <HideAmountsToggle />
  </div>
);
