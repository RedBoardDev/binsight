import type { ReactNode } from 'react';
import { BinSamples } from './Charts/BinSamples';
import { CandleSamples } from './Charts/CandleSamples';
import { PulseSample } from './Charts/PulseSample';
import { SeriesSamples } from './Charts/SeriesSamples';
import { FigureReasonSample } from './FigureReasonSample';

interface SampleSectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

const SampleSection = ({ title, children }: SampleSectionProps) => (
  <section className="flex flex-col gap-5">
    <h2 className="text-section">{title}</h2>
    {children}
  </section>
);

// The shared pieces that no screen shows yet, on fixed samples, for the visual tests only. It is
// never part of the app: Vite serves it in development, and the production build never sees it.
export const HarnessPage = () => (
  <main className="mx-auto flex max-w-290 flex-col gap-16 px-4 py-10 lg:px-8">
    <h1 className="text-page-title">Test harness</h1>
    <SampleSection title="Figures">
      <FigureReasonSample />
    </SampleSection>
    <SampleSection title="Charts">
      <PulseSample />
      <BinSamples />
      <SeriesSamples />
      <CandleSamples />
    </SampleSection>
  </main>
);
