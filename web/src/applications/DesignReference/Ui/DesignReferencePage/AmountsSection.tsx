import {
  SAMPLE_AMOUNTS,
  SAMPLE_PERCENTS,
  SAMPLE_PRICES,
  SAMPLE_TOKEN_QUANTITY,
} from '@app/applications/DesignReference/Ui/DesignReferencePage/designSamples';
import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { PriceValue } from '@app/applications/Shared/Figure/Ui/PriceValue';
import { TokenQuantity } from '@app/applications/Shared/Figure/Ui/TokenQuantity';
import type { ReactNode } from 'react';

interface SpecimenProps {
  label: string;
  children: ReactNode;
}

const Specimen = ({ label, children }: SpecimenProps) => (
  <div className="flex min-h-14 flex-col justify-end gap-1.5 border-border-subtle border-b pb-3">
    <span className="text-small text-faint">{label}</span>
    <span className="text-body">{children}</span>
  </div>
);

export const AmountsSection = () => (
  <ReferenceSection title="Amounts">
    <div className="flex flex-wrap items-baseline gap-x-10 gap-y-4">
      <span className="text-hero">
        <FigureAmount figure={SAMPLE_AMOUNTS.today} placement="hero" signing="always" />
      </span>
      <span className="text-key">
        <FigureAmount figure={SAMPLE_AMOUNTS.netWorth} placement="key" signing="negative-only" />
      </span>
      <span className="text-pair">
        <FigureAmount figure={SAMPLE_AMOUNTS.gain} placement="key" signing="always" />
      </span>
    </div>
    <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
      <Specimen label="Loss, true minus">
        <FigureAmount figure={SAMPLE_AMOUNTS.loss} placement="body" signing="always" />
      </Specimen>
      <Specimen label="Dust, no sign">
        <FigureAmount figure={SAMPLE_AMOUNTS.dust} placement="body" signing="always" />
      </Specimen>
      <Specimen label="Unavailable">
        <FigureAmount figure={SAMPLE_AMOUNTS.unavailable} placement="body" signing="always" />
      </Specimen>
      <Specimen label="From 1,000 SOL">
        <FigureAmount figure={SAMPLE_AMOUNTS.large} placement="body" signing="always" />
      </Specimen>
      <Specimen label="Dollars">
        <FigureAmount figure={SAMPLE_AMOUNTS.dollars} placement="body" signing="always" />
      </Specimen>
      <Specimen label="Below one dollar">
        <FigureAmount figure={SAMPLE_AMOUNTS.cents} placement="body" signing="always" />
      </Specimen>
      <Specimen label="Stablecoin">
        <FigureAmount figure={SAMPLE_AMOUNTS.stablecoin} placement="body" signing="negative-only" />
      </Specimen>
      <Specimen label="Value cell, unit in header">
        <FigureAmount
          figure={SAMPLE_AMOUNTS.netWorth}
          placement="cell-value"
          signing="negative-only"
          layout="column"
          unit="hidden"
        />
      </Specimen>
      <Specimen label="Percent, cell">
        <PercentValue figure={SAMPLE_PERCENTS.gain} placement="cell" signing="always" />{' '}
        <PercentValue figure={SAMPLE_PERCENTS.loss} placement="cell" signing="always" />
      </Specimen>
      <Specimen label="From 1,000 %">
        <PercentValue figure={SAMPLE_PERCENTS.huge} placement="hero" signing="always" />
      </Specimen>
      <Specimen label="Prices">
        <PriceValue price={SAMPLE_PRICES.ordinary} /> · <PriceValue price={SAMPLE_PRICES.tiny} />
      </Specimen>
      <Specimen label="Token quantity">
        <TokenQuantity amount={SAMPLE_TOKEN_QUANTITY} symbol="BONK" />
      </Specimen>
    </div>
  </ReferenceSection>
);
