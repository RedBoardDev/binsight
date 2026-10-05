import { type RefObject, useEffect, useRef, useState } from 'react';

const INITIAL_CHART_WIDTH_PX = 600;
const MINIMUM_CHART_WIDTH_PX = 120;

interface ElementWidth {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly width: number;
}

export const useElementWidth = (): ElementWidth => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(INITIAL_CHART_WIDTH_PX);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (value: number) => {
      if (Number.isFinite(value)) setWidth(Math.max(MINIMUM_CHART_WIDTH_PX, Math.round(value)));
    };
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
};
