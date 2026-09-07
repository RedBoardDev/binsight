'use client';

import { PERIOD_OPTIONS } from '@app/applications/Stats/Domain/period';
import { useUi } from '@app/core/stores/uiStore';
import type { Bucket } from '@binsight/shared';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';

const BUCKET_OPTIONS: { label: string; value: Bucket }[] = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
];

interface PeriodFilterBarProps {
  bucket: Bucket;
  onBucket: (bucket: Bucket) => void;
}

/** The Stats tab's two time controls: the chart's bucket width, and the range every panel reads. */
export const PeriodFilterBar = ({ bucket, onBucket }: PeriodFilterBarProps) => {
  const period = useUi((s) => s.period);
  const setPeriod = useUi((s) => s.setPeriod);

  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      <FilterGroup label="Interval" options={BUCKET_OPTIONS} value={bucket} onChange={onBucket} />
      <FilterGroup label="Range" options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
    </div>
  );
};

interface FilterGroupProps<T extends string> {
  label: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}

function FilterGroup<T extends string>({ label, options, value, onChange }: FilterGroupProps<T>) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1.5">
      <span className="font-medium text-[11px] text-faint uppercase tracking-wide">{label}</span>
      {/* The Range row overflows a phone: scroll it horizontally, with the vertical padding pulled
          back in so the focus ring is never clipped by the scroll container. */}
      <div className="-my-1 scrollbar-none min-w-0 max-w-full overflow-x-auto py-1">
        <ToggleButtonGroup.Root
          aria-label={label}
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[value]}
          onSelectionChange={(keys) => {
            const picked = options.find((option) => keys.has(option.value));
            if (picked) onChange(picked.value);
          }}
        >
          {options.map((option) => (
            <ToggleButton.Root key={option.value} id={option.value} className="h-11 md:h-9">
              {option.label}
            </ToggleButton.Root>
          ))}
        </ToggleButtonGroup.Root>
      </div>
    </div>
  );
}
