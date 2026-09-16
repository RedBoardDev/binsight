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
  /**
   * The unit this position's economics are actually denominated in. A USDC pool reports USDC; the
   * SOL columns stay zero for it, so displaying them would read as a flat, and wrong, zero.
   */
  get quoteSymbol(): string {
    return this.raw.quoteSymbol ?? 'SOL';
  }
  get displaySize(): number {
    return this.raw.sizeQuote ?? this.raw.sizeSol;
  }
  get displayPnl(): number {
    return this.raw.pnlQuote ?? this.raw.pnlSol;
  }
  get pnlPct(): number {
    return this.raw.pnlPctQuote ?? this.raw.pnlPctSol;
  }
  get tone(): Tone {
    return toneOf(this.displayPnl);
  }
  get totalFeesSol(): number {
    return this.raw.claimedFeesSol + this.raw.unclaimedFeesSol;
  }
  get displayTotalFees(): number {
    return (
      (this.raw.claimedFeesQuote ?? this.raw.claimedFeesSol) +
      (this.raw.unclaimedFeesQuote ?? this.raw.unclaimedFeesSol)
    );
  }
  /** Combined (claimed + unclaimed) fees as a percentage of the position's current value. */
  get feeYieldPct(): number {
    return this.displaySize > 0 ? (this.displayTotalFees / this.displaySize) * 100 : 0;
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
  /** See {@link OpenPositionEntity.quoteSymbol}. */
  get quoteSymbol(): string {
    return this.raw.quoteSymbol ?? 'SOL';
  }
  get displayPnl(): number {
    return this.raw.pnlQuote ?? this.raw.pnlSol;
  }
  get pnlPct(): number {
    return this.raw.pnlPctQuote ?? this.raw.pnlPctSol;
  }
  get feesSol(): number {
    return this.raw.feesSol;
  }
  get displayFees(): number {
    return this.raw.feesQuote ?? this.raw.feesSol;
  }
  get displayDeposit(): number {
    return this.raw.depositQuote ?? this.raw.depositSol;
  }
  get tone(): Tone {
    return toneOf(this.displayPnl);
  }
  get closedAt(): number | null {
    return this.raw.closedAt;
  }
  get durationSeconds(): number | null {
    return this.raw.durationSeconds;
  }
}
