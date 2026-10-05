import type { PulsePoint } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { useLingui } from '@lingui/react/macro';

interface PulseTableProps {
  readonly points: readonly PulsePoint[];
  readonly label: string;
  readonly describePoint: (index: number) => string;
}

export const PulseTable = ({ points, label, describePoint }: PulseTableProps) => {
  const { t } = useLingui();
  // A table keeps its intrinsic width despite sr-only's 1px width and can zoom out the
  // mobile viewport. Clip a wrapper instead, while preserving the native table semantics.
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
          {points.map((point, index) => (
            <tr key={point.start}>
              <td>{describePoint(index)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
