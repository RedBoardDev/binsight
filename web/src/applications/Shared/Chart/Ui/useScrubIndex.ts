import { nearestPoint } from '@app/applications/Shared/Chart/Domain/nearestPoint';
import {
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEvent,
  type PointerEventHandler,
  useRef,
} from 'react';

export const TOUCH_SCRUB_THRESHOLD_PX = 10;
export type ScrubRetention = 'gesture' | 'reading';

interface ScrubOptions {
  readonly positions: readonly number[];
  readonly width: number;
  readonly activeIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly readoutRetention?: ScrubRetention;
}

interface ScrubGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly direction: 'pending' | 'horizontal' | 'vertical';
}

interface ScrubEvents {
  readonly onPointerDown: PointerEventHandler<HTMLDivElement>;
  readonly onPointerMove: PointerEventHandler<HTMLDivElement>;
  readonly onPointerUp: PointerEventHandler<HTMLDivElement>;
  readonly onPointerLeave: PointerEventHandler<HTMLDivElement>;
  readonly onPointerCancel: PointerEventHandler<HTMLDivElement>;
  readonly onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  readonly onFocus: FocusEventHandler<HTMLDivElement>;
  readonly onBlur: FocusEventHandler<HTMLDivElement>;
}

const KEY_OFFSET: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
};

export const useScrubIndex = ({
  positions,
  width,
  activeIndex,
  onScrub,
  readoutRetention = 'gesture',
}: ScrubOptions): ScrubEvents => {
  const gesture = useRef<ScrubGesture | null>(null);
  const choosePoint = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const x = ((event.clientX - box.left) * width) / box.width;
    onScrub(nearestPoint(positions, x));
  };
  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    onScrub(null);
  };
  return {
    onPointerDown: (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      if (event.pointerType !== 'touch') {
        choosePoint(event);
        return;
      }
      gesture.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        direction: 'pending',
      };
    },
    onPointerMove: (event) => {
      if (event.pointerType !== 'touch') {
        choosePoint(event);
        return;
      }
      const current = gesture.current;
      if (
        current === null ||
        current.pointerId !== event.pointerId ||
        current.direction === 'vertical'
      )
        return;
      const horizontal = Math.abs(event.clientX - current.startX);
      const vertical = Math.abs(event.clientY - current.startY);
      if (current.direction === 'pending') {
        if (vertical >= TOUCH_SCRUB_THRESHOLD_PX && vertical >= horizontal) {
          gesture.current = { ...current, direction: 'vertical' };
          return;
        }
        if (horizontal < TOUCH_SCRUB_THRESHOLD_PX || horizontal <= vertical) return;
        gesture.current = { ...current, direction: 'horizontal' };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      choosePoint(event);
    },
    onPointerUp: (event) => {
      if (event.pointerType !== 'touch') return;
      if (readoutRetention === 'reading' && gesture.current?.direction === 'horizontal') {
        gesture.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        return;
      }
      cancel(event);
    },
    onPointerCancel: cancel,
    onPointerLeave: (event) => {
      if (
        event.pointerType === 'touch' &&
        readoutRetention === 'reading' &&
        gesture.current === null
      )
        return;
      if (event.pointerType !== 'touch' || gesture.current?.direction !== 'horizontal')
        cancel(event);
    },
    onKeyDown: (event) => {
      if (positions.length === 0) return;
      const offset = KEY_OFFSET[event.key];
      if (
        offset === undefined &&
        event.key !== 'Home' &&
        event.key !== 'End' &&
        event.key !== 'Escape'
      )
        return;
      event.preventDefault();
      if (event.key === 'Escape') {
        onScrub(null);
        return;
      }
      const current = activeIndex ?? positions.length - 1;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? positions.length - 1
            : current + (offset ?? 0);
      onScrub(Math.max(0, Math.min(positions.length - 1, next)));
    },
    onFocus: () => {
      if (positions.length > 0) onScrub(activeIndex ?? positions.length - 1);
    },
    onBlur: () => {
      gesture.current = null;
      onScrub(null);
    },
  };
};
