import { Tabs } from '@heroui/react';
import type { ReactNode } from 'react';

export interface SegmentedTab<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly panel: ReactNode;
}

interface SegmentedTabsProps<Id extends string> {
  label: string;
  tabs: readonly SegmentedTab<Id>[];
  selected: Id;
  onChange: (selected: Id) => void;
}

export const SegmentedTabs = <Id extends string>({
  label,
  tabs,
  selected,
  onChange,
}: SegmentedTabsProps<Id>) => (
  <Tabs
    selectedKey={selected}
    onSelectionChange={(key) => {
      const tab = tabs.find((candidate) => candidate.id === key);
      if (tab !== undefined) {
        onChange(tab.id);
      }
    }}
    className="segmented-tabs"
  >
    <Tabs.ListContainer className="w-fit">
      <Tabs.List aria-label={label}>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.id} id={tab.id}>
            {tab.label}
            <Tabs.Indicator />
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.ListContainer>
    {tabs.map((tab) => (
      <Tabs.Panel key={tab.id} id={tab.id} className="p-0 pt-6">
        {tab.panel}
      </Tabs.Panel>
    ))}
  </Tabs>
);
