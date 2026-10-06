import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';

const amount = parseDecimalString('61.541203117');
if (amount === null) throw new Error('the sample net worth is not a decimal string');

const PARTIAL_NET_WORTH: Figure = {
  exactness: 'partial',
  value: { amount, unit: 'sol' },
  reasons: [{ code: 'unpriced_token', mint: 'sample-mint', wallet: 'sample-wallet' }],
};

// A lower bound, whose glyph opens its reasons: the touch area beside the glyph is tested on it.
export const FigureReasonSample = () => (
  <p className="text-key">
    <FigureAmount figure={PARTIAL_NET_WORTH} placement="key" signing="negative-only" />
  </p>
);
