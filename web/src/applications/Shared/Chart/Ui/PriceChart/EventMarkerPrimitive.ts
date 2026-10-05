import type { PlottedEventMarker } from '@app/applications/Shared/Chart/Domain/Candle/eventMarkers';
import type { PriceChartTheme } from '@app/applications/Shared/Chart/Ui/PriceChart/chartTheme';
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';

interface MarkerCircle {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly letter: string;
}

const MARKER_RADIUS_PX = 6;
const ACTIVE_MARKER_RADIUS_PX = 8;
const UNPRICED_MARKER_Y_PX = 22;

export class EventMarkerPrimitive implements ISeriesPrimitive<Time>, IPrimitivePaneRenderer {
  private attachment: SeriesAttachedParameter<Time> | null = null;
  private markers: readonly PlottedEventMarker[] = [];
  private circles: readonly MarkerCircle[] = [];
  private theme: PriceChartTheme;
  private activeId: string | null = null;
  private readonly view: IPrimitivePaneView = { renderer: () => this, zOrder: () => 'top' };

  constructor(theme: PriceChartTheme) {
    this.theme = theme;
  }

  attached(attachment: SeriesAttachedParameter<Time>): void {
    this.attachment = attachment;
  }
  detached(): void {
    this.attachment = null;
  }

  update(
    markers: readonly PlottedEventMarker[],
    theme: PriceChartTheme,
    activeId: string | null,
  ): void {
    this.markers = markers;
    this.theme = theme;
    this.activeId = activeId;
    this.attachment?.requestUpdate();
  }

  updateAllViews(): void {
    this.circles = this.markers.flatMap((marker) => {
      const x =
        this.attachment?.chart.timeScale().timeToCoordinate(marker.time as UTCTimestamp) ?? null;
      const y =
        marker.price === null
          ? UNPRICED_MARKER_Y_PX
          : (this.attachment?.series.priceToCoordinate(marker.price) ?? null);
      return x === null || y === null ? [] : [{ id: marker.id, x, y, letter: marker.letter }];
    });
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const circle = this.circles.findLast(
      (marker) => Math.hypot(marker.x - x, marker.y - y) <= ACTIVE_MARKER_RADIUS_PX,
    );
    return circle === undefined
      ? null
      : { externalId: circle.id, zOrder: 'top', cursorStyle: 'pointer' };
  }

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
    const drawInMediaSpace = target.useMediaCoordinateSpace.bind(target);
    drawInMediaSpace(({ context }) => {
      context.save();
      context.font = `600 9px ${this.theme.fontFamily}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const circle of this.circles) {
        context.beginPath();
        context.arc(
          circle.x,
          circle.y,
          circle.id === this.activeId ? ACTIVE_MARKER_RADIUS_PX : MARKER_RADIUS_PX,
          0,
          Math.PI * 2,
        );
        context.fillStyle = this.theme.background;
        context.strokeStyle = this.theme.foreground;
        context.lineWidth = 1;
        context.fill();
        context.stroke();
        context.fillStyle = this.theme.foreground;
        context.fillText(circle.letter, circle.x, circle.y);
      }
      context.restore();
    });
  }
}
