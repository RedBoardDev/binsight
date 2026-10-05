import { useLingui } from '@lingui/react/macro';

interface ChartReadingsProps {
  readonly keys: readonly string[];
  readonly label: string;
  readonly describePoint: (index: number) => string;
}

export const ChartReadings = ({ keys, label, describePoint }: ChartReadingsProps) => {
  const { t } = useLingui();
  // Clip the wrapper: sr-only on a native table still expands the mobile viewport.
  return (
    <div className="sr-only">
      <table>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t`Chart readings`}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key, index) => (
            <tr key={key}>
              <td>{describePoint(index)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
