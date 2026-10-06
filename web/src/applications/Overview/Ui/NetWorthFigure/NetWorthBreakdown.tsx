import { requireDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { TokenQuantity } from '@app/applications/Shared/Figure/Ui/TokenQuantity';
import { shortAddress } from '@app/applications/Shared/Token/Domain/shortAddress';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';

interface NetWorthBreakdownProps {
  readonly netWorth: ApiSchema<'OverviewV2'>['net_worth'];
}

export const NetWorthBreakdown = ({ netWorth }: NetWorthBreakdownProps) => {
  const { t } = useLingui();
  const parts = [
    { label: t`Liquidity`, figure: netWorth.lp },
    { label: t`Idle`, figure: netWorth.idle },
    { label: t`Unclaimed fees`, figure: netWorth.unclaimed_fees },
    { label: t`Recoverable rent`, figure: netWorth.recoverable_rent },
  ];
  return (
    <div className="flex max-w-80 flex-col gap-3">
      <h3 className="text-body font-semibold">{t`Net worth breakdown`}</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-2 text-body">
        {parts.map(({ label, figure }) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="justify-self-end">
              <FigureAmount
                figure={figure}
                placement="body"
                signing="negative-only"
                layout="column"
              />
            </dd>
          </div>
        ))}
      </dl>
      {netWorth.unpriced.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3 text-small">
          <h4 className="font-medium">{t`Holdings without a price`}</h4>
          <p className="text-muted">{t`These holdings are not included in net worth.`}</p>
          <ul className="flex flex-col gap-2">
            {netWorth.unpriced.map((holding) => (
              <li
                key={`${holding.wallet.address}:${holding.token.mint}`}
                className="flex flex-wrap justify-between gap-x-4 gap-y-1"
              >
                <span className="text-muted">{holding.wallet.label}</span>
                <TokenQuantity
                  amount={requireDecimalString(holding.amount)}
                  symbol={holding.token.symbol ?? shortAddress(holding.token.mint)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
