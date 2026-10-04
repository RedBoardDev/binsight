import { IconAction } from '@app/applications/Shared/Control/Ui/IconAction';
import { MultiSelectMenu } from '@app/applications/Shared/Control/Ui/MultiSelectMenu';
import { SegmentedTabs } from '@app/applications/Shared/Control/Ui/SegmentedTabs';
import { TextMenu } from '@app/applications/Shared/Control/Ui/TextMenu';
import { type ListView, ViewToggle } from '@app/applications/Shared/Control/Ui/ViewToggle';
import { Download } from 'lucide-react';
import { useState } from 'react';

const OUTCOMES = [
  { id: 'all', label: 'All' },
  { id: 'win', label: 'Win' },
  { id: 'loss', label: 'Loss' },
] as const;

const STRATEGIES = [
  { id: 'spot', label: 'Spot' },
  { id: 'curve', label: 'Curve' },
  { id: 'bid-ask', label: 'Bid-Ask' },
] as const;

type Outcome = (typeof OUTCOMES)[number]['id'];
type Strategy = (typeof STRATEGIES)[number]['id'];
type Series = 'net-worth' | 'real-pnl' | 'positions';

export const FilterSpecimens = () => {
  const [view, setView] = useState<ListView>('table');
  const [outcome, setOutcome] = useState<Outcome>('all');
  const [strategies, setStrategies] = useState<Strategy[]>(['spot', 'curve']);
  const [series, setSeries] = useState<Series>('real-pnl');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <ViewToggle selected={view} onChange={setView} />
        <TextMenu
          label="Outcome"
          options={OUTCOMES}
          selected={outcome}
          neutral="all"
          onChange={setOutcome}
        />
        <MultiSelectMenu
          label="Strategy"
          options={STRATEGIES}
          selected={strategies}
          onChange={setStrategies}
        />
        <IconAction label="Export CSV" Icon={Download} onPress={() => undefined} />
      </div>
      <SegmentedTabs
        label="Series"
        selected={series}
        onChange={setSeries}
        tabs={[
          {
            id: 'net-worth',
            label: 'Net worth',
            panel: <span className="text-muted">Net worth</span>,
          },
          {
            id: 'real-pnl',
            label: 'Real PnL',
            panel: <span className="text-muted">Real PnL</span>,
          },
          {
            id: 'positions',
            label: 'Positions PnL',
            panel: <span className="text-muted">Positions</span>,
          },
        ]}
      />
    </div>
  );
};
