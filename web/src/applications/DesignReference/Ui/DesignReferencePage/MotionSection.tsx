import { SAMPLE_LIVE_VALUES } from '@app/applications/DesignReference/Ui/DesignReferencePage/designSamples';
import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { FigureSwap } from '@app/applications/Shared/Figure/Ui/FigureSwap';
import { Button } from '@heroui/react';
import { type CSSProperties, useState } from 'react';

const LENS_STOPS = ['7d', '1M', '3M', '1Y'] as const;

export const MotionSection = () => {
  const [stop, setStop] = useState(0);
  const [live, setLive] = useState(0);
  const amount = SAMPLE_LIVE_VALUES[live % SAMPLE_LIVE_VALUES.length] ?? SAMPLE_LIVE_VALUES[0];
  const lensStyle = { '--lens-index': stop } as CSSProperties;

  return (
    <ReferenceSection title="Motion">
      <div className="relative flex w-72 rounded-full bg-inset p-1">
        <span
          aria-hidden
          style={lensStyle}
          className="absolute top-1 left-1 h-9 w-[calc((100%-0.5rem)/4)] translate-x-[calc(var(--lens-index)*100%)] rounded-full bg-overlay shadow-thumb transition-[translate] duration-(--duration-spring-lens) ease-lens"
        />
        {LENS_STOPS.map((label, index) => (
          <Button
            key={label}
            variant="ghost"
            onPress={() => setStop(index)}
            className="relative h-9 flex-1 rounded-full font-medium text-meta"
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="grid h-20 w-40 place-items-center rounded-2xl bg-surface text-meta text-muted shadow-thumb transition-transform duration-(--duration-press) ease-out active:scale-(--press-scale)">
          Press me
        </div>
        <span className="text-key">
          <FigureSwap value={amount}>
            <FigureAmount
              figure={{ exactness: 'complete', value: { amount, unit: 'sol' } }}
              placement="key"
              signing="always"
            />
          </FigureSwap>
        </span>
        <Button variant="secondary" onPress={() => setLive((value) => value + 1)}>
          Next live value
        </Button>
      </div>
    </ReferenceSection>
  );
};
