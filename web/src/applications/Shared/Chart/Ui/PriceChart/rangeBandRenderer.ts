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
import type { PriceChartTheme } from '@app/applications/Shared/Chart/Ui/PriceChart/chartTheme';
import type { IPrimitivePaneRenderer } from 'lightweight-charts';

export interface RangeRectangle {
  readonly from: number;
  readonly to: number;
  readonly upper: number;
  readonly lower: number;
}

export class RangeBandRenderer implements IPrimitivePaneRenderer {
  private readonly rectangles: readonly RangeRectangle[];
  private readonly closedX: number | null;
  private readonly theme: PriceChartTheme;

  constructor(
    rectangles: readonly RangeRectangle[],
    closedX: number | null,
    theme: PriceChartTheme,
  ) {
    this.rectangles = rectangles;
    this.closedX = closedX;
    this.theme = theme;
  }

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
    if (this.closedX === null) return;
    const drawInMediaSpace = target.useMediaCoordinateSpace.bind(target);
    drawInMediaSpace(({ context, mediaSize }) => {
      context.save();
      context.strokeStyle = this.theme.muted;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(this.closedX ?? 0, 0);
      context.lineTo(this.closedX ?? 0, mediaSize.height);
      context.stroke();
      context.restore();
    });
  }

  drawBackground(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
    const drawInMediaSpace = target.useMediaCoordinateSpace.bind(target);
    drawInMediaSpace(({ context }) => {
      context.save();
      for (const rectangle of this.rectangles) {
        const width = rectangle.to - rectangle.from;
        const height = rectangle.lower - rectangle.upper;
        context.fillStyle = this.theme.accent;
        context.globalAlpha = 0.06;
        context.fillRect(rectangle.from, rectangle.upper, width, height);
        context.globalAlpha = 0.3;
        context.strokeStyle = this.theme.accent;
        context.lineWidth = 1;
        context.setLineDash([3, 3]);
        context.beginPath();
        context.moveTo(rectangle.from, rectangle.upper);
        context.lineTo(rectangle.to, rectangle.upper);
        context.moveTo(rectangle.from, rectangle.lower);
        context.lineTo(rectangle.to, rectangle.lower);
        context.stroke();
      }
      context.restore();
    });
  }
}
