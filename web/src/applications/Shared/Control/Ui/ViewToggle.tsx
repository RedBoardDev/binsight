import { TextPills } from '@app/applications/Shared/Control/Ui/TextPills';
import { useLingui } from '@lingui/react/macro';
import { LayoutGrid, Rows3 } from 'lucide-react';

export type ListView = 'table' | 'cards';

interface ViewToggleProps {
  selected: ListView;
  onChange: (view: ListView) => void;
}

export const ViewToggle = ({ selected, onChange }: ViewToggleProps) => {
  const { t } = useLingui();

  return (
    <TextPills
      label={t`View`}
      options={[
        { id: 'table', label: t`Table`, Icon: Rows3 },
        { id: 'cards', label: t`Cards`, Icon: LayoutGrid },
      ]}
      selected={selected}
      onChange={onChange}
    />
  );
};
