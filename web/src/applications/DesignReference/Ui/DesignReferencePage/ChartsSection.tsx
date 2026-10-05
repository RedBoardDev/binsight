import { CHART_SAMPLES } from '@app/applications/DesignReference/Ui/DesignReferencePage/chartSamples';
import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';
import { PulseChart } from '@app/applications/Shared/Chart/Ui/PulseChart';
import { useState } from 'react';
import { BinSamples } from './ChartsSection/BinSamples';
import { CandleSamples } from './ChartsSection/CandleSamples';
import { SampleReadout } from './ChartsSection/SampleReadout';
import { SeriesSamples } from './ChartsSection/SeriesSamples';
import { useSampleReadings } from './ChartsSection/useSampleReadings';

export const ChartsSection = () => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const describePoint = useSampleReadings();
  return (
    <ReferenceSection title="Charts">
      <PulseChart
        points={CHART_SAMPLES}
        label="Real PnL sample"
        summary="Daily profit and cumulative profit, October 1 to 7, with estimated and missing readings."
        activeIndex={activeIndex}
        onScrub={setActiveIndex}
        describePoint={describePoint}
        renderReadout={(index) => <SampleReadout index={index} />}
      />
      <BinSamples />
      <SeriesSamples />
      <CandleSamples />
    </ReferenceSection>
  );
};
