import { OpenPositionEntity } from '@app/applications/Position/Domain/position';
import type { WalletState } from '@binsight/shared';

/** The aggregated wallet snapshot, with open positions mapped to entities. */
export class Portfolio {
  readonly open: OpenPositionEntity[];

  constructor(readonly state: WalletState) {
    this.open = state.openPositions.map((p) => new OpenPositionEntity(p));
  }

  get totals() {
    return this.state.totals;
  }

  /** Open positions sorted by current size, largest first. */
  get openByValue(): OpenPositionEntity[] {
    return [...this.open].sort((a, b) => b.sizeSol - a.sizeSol);
  }
}
