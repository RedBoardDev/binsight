/*
 * Adapted from TradingView's Lightweight Charts Bands example, modified for server-supplied ranges.
 * Copyright 2023 TradingView, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations.
 */
import {
  candleLogicalIndex,
  chartTimestamp,
  type PriceChartSeries,
  timeframeSeconds,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import type { PriceChartTheme } from '@app/applications/Shared/Chart/Ui/PriceChart/chartTheme';
import {
  RangeBandRenderer,
  type RangeRectangle,
} from '@app/applications/Shared/Chart/Ui/PriceChart/rangeBandRenderer';
import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type {
  AutoscaleInfo,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

interface PriceLabel {
  readonly coordinate: number;
  readonly text: string;
}

export class RangeBandPrimitive implements ISeriesPrimitive<Time> {
  private attachment: SeriesAttachedParameter<Time> | null = null;
  private rectangles: readonly RangeRectangle[] = [];
  private labels: readonly PriceLabel[] = [];
  private closedX: number | null = null;
  private times: readonly number[] = [];
  private axisViews: readonly ISeriesPrimitiveAxisView[] = [];
  private readonly view: IPrimitivePaneView = {
    renderer: () => new RangeBandRenderer(this.rectangles, this.closedX, this.theme),
  };

  private source: PriceChartSeries;
  private theme: PriceChartTheme;
  private formatPrice: (price: DecimalString) => string;

  constructor(
    source: PriceChartSeries,
    theme: PriceChartTheme,
    formatPrice: (price: DecimalString) => string,
  ) {
    this.source = source;
    this.times = source.candles.map((candle) => chartTimestamp(candle.start));
    this.theme = theme;
    this.formatPrice = formatPrice;
  }

  attached(attachment: SeriesAttachedParameter<Time>): void {
    this.attachment = attachment;
    attachment.requestUpdate();
  }

  detached(): void {
    this.attachment = null;
  }

  update(
    source: PriceChartSeries,
    theme: PriceChartTheme,
    formatPrice: (price: DecimalString) => string,
  ): void {
    this.source = source;
    this.times = source.candles.map((candle) => chartTimestamp(candle.start));
    this.theme = theme;
    this.formatPrice = formatPrice;
    this.attachment?.requestUpdate();
  }

  private timeCoordinate(timestamp: string): number | null {
    const logical = candleLogicalIndex(
      this.times,
      chartTimestamp(timestamp),
      this.source.timeframe,
    );
    const scale = this.attachment?.chart.timeScale();
    if (logical === null || scale === undefined) return null;
    // The SDK returns zero for fractional logical indices. Interpolate drawing pixels instead.
    const leftIndex = Math.floor(logical);
    const left = scale.logicalToCoordinate(leftIndex as Logical);
    const right = scale.logicalToCoordinate((leftIndex + 1) as Logical);
    return left === null || right === null ? null : left + (right - left) * (logical - leftIndex);
  }

  private priceCoordinate(price: DecimalString): number | null {
    const plotted = plotValue(price);
    return plotted === null ? null : (this.attachment?.series.priceToCoordinate(plotted) ?? null);
  }

  updateAllViews(): void {
    const lastCandle = this.source.candles.at(-1);
    const end =
      this.source.closedAt ??
      (lastCandle === undefined
        ? null
        : new Date(
            (chartTimestamp(lastCandle.start) + timeframeSeconds(this.source.timeframe)) * 1000,
          ).toISOString());
    this.rectangles = this.source.ranges.flatMap((range) => {
      if (end === null) return [];
      const from = this.timeCoordinate(range.from);
      const to = this.timeCoordinate(range.to ?? end);
      const upper = this.priceCoordinate(range.upper);
      const lower = this.priceCoordinate(range.lower);
      return from === null || to === null || upper === null || lower === null || from > to
        ? []
        : [{ from, to, upper, lower }];
    });
    this.closedX =
      this.source.closedAt === undefined ? null : this.timeCoordinate(this.source.closedAt);
    const latestRange = this.source.ranges.at(-1);
    const prices = [
      latestRange?.lower,
      latestRange?.upper,
      this.source.closedAt === undefined ? this.source.currentPrice : undefined,
    ];
    this.labels = prices.flatMap((price) => {
      if (price === undefined) return [];
      const coordinate = this.priceCoordinate(price);
      return coordinate === null ? [] : [{ coordinate, text: this.formatPrice(price) }];
    });
    this.axisViews = this.labels.map((label) => ({
      coordinate: () => label.coordinate,
      text: () => label.text,
      textColor: () => this.theme.muted,
      backColor: () => this.theme.background,
      tickVisible: () => false,
    }));
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  autoscaleInfo(): AutoscaleInfo | null {
    const prices = this.source.ranges
      .flatMap((range) => [plotValue(range.lower), plotValue(range.upper)])
      .filter((price): price is number => price !== null);
    return prices.length === 0
      ? null
      : {
          priceRange: {
            minValue: Math.min(...prices),
            maxValue: Math.max(...prices),
          },
        };
  }
}
