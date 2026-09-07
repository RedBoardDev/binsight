import { type Tone, toneOf } from '@app/applications/Shared/Domain/tone';
import type { ClosedPosition, OpenPosition, RangeStatus, StrategyFamily } from '@binsight/shared';

/** An open position with the derived values the UI needs (range placement, tone, total fees). */
export class OpenPositionEntity {
  constructor(readonly raw: OpenPosition) {}

  get address(): string {
    return this.raw.positionAddress;
  }
  get pair(): string {
    return `${this.raw.tokenX}/${this.raw.tokenY}`;
  }
  get strategy(): StrategyFamily | null {
    return this.raw.strategy;
  }
  get sizeSol(): number {
    return this.raw.sizeSol;
  }
  get pnlSol(): number {
    return this.raw.pnlSol;
  }
  get pnlPct(): number {
    return this.raw.pnlPctSol;
  }
  get tone(): Tone {
    return toneOf(this.raw.pnlSol);
  }
  get totalFeesSol(): number {
    return this.raw.claimedFeesSol + this.raw.unclaimedFeesSol;
  }
  /** Combined (claimed + unclaimed) fees as a percentage of the position's current value. */
  get feeYieldPct(): number {
    return this.sizeSol > 0 ? (this.totalFeesSol / this.sizeSol) * 100 : 0;
  }
  get rangeStatus(): RangeStatus {
    return this.raw.rangeStatus;
  }
  get inRange(): boolean {
    return this.raw.rangeStatus === 'in';
  }
}

/** A closed position with derived win/tone/duration helpers. */
export class ClosedPositionEntity {
  constructor(readonly raw: ClosedPosition) {}

  get address(): string {
    return this.raw.positionAddress;
  }
  get pair(): string {
    return `${this.raw.tokenX}/${this.raw.tokenY}`;
  }
  get strategy(): StrategyFamily | null {
    return this.raw.strategy;
  }
  get pnlSol(): number {
    return this.raw.pnlSol;
  }
  get pnlPct(): number {
    return this.raw.pnlPctSol;
  }
  get feesSol(): number {
    return this.raw.feesSol;
  }
  get tone(): Tone {
    return toneOf(this.raw.pnlSol);
  }
  get closedAt(): number | null {
    return this.raw.closedAt;
  }
  get durationSeconds(): number | null {
    return this.raw.durationSeconds;
  }
}
