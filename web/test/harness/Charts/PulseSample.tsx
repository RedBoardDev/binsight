import { PulseChart } from '@app/applications/Shared/Chart/Ui/PulseChart';
import { useState } from 'react';
import { PulseSampleReadout } from './PulseSampleReadout';
import { CHART_SAMPLES } from './pulseSamples';
import { usePulseSampleReadings } from './usePulseSampleReadings';

export const PulseSample = () => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const describePoint = usePulseSampleReadings();
  return (
    <PulseChart
      points={CHART_SAMPLES}
      label="Real PnL sample"
      summary="Daily profit and cumulative profit, October 1 to 7, with estimated and missing readings."
      activeIndex={activeIndex}
      onScrub={setActiveIndex}
      describePoint={describePoint}
      renderReadout={(index) => <PulseSampleReadout index={index} />}
    />
  );
};
