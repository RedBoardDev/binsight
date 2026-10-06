import { PERIOD_LABELS, PERIODS } from '@app/applications/Shared/Scope/Domain/period';
import { useScope } from '@app/applications/Shared/Scope/Ui/useScope';
import { Button, Dropdown, Label } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { ChevronDown } from 'lucide-react';

// The period beside the GAIN label, in the accent: the same app-wide period as the chart's pills.
// The button is 44 px tall for the finger; its negative margin keeps the label line at 20 px.
export const GainPeriodMenu = () => {
  const { t, i18n } = useLingui();
  const { period, setPeriod } = useScope();
  return (
    <Dropdown>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t`Period`}
        className="-my-3 h-11 min-w-0 gap-0.5 px-1 font-semibold text-accent text-small"
      >
        <span className="num">{i18n._(PERIOD_LABELS[period])}</span>
        <ChevronDown aria-hidden strokeWidth={1.75} className="size-3" />
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-28">
        <Dropdown.Menu
          aria-label={t`Period`}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[period]}
          onSelectionChange={(keys) => {
            const next = PERIODS.find((candidate) => keys !== 'all' && keys.has(candidate));
            if (next !== undefined) setPeriod(next);
          }}
        >
          {PERIODS.map((id) => (
            <Dropdown.Item key={id} id={id} textValue={i18n._(PERIOD_LABELS[id])}>
              <Label>{i18n._(PERIOD_LABELS[id])}</Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
};
