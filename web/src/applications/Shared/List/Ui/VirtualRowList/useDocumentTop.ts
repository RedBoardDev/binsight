import { type RefObject, useLayoutEffect, useState } from 'react';

// Rows are placed from the top of the document. Anything above the list that changes height (a
// banner, wrapping filters, a late web font) moves them, re-render or not: the page is observed.
// offsetTop would be wrong here: a table is the offset parent of its sections.
export const useDocumentTop = (ref: RefObject<HTMLElement | null>): number => {
  const [top, setTop] = useState(0);

  useLayoutEffect(() => {
    const measure = (): void => {
      if (ref.current !== null) {
        setTop(ref.current.getBoundingClientRect().top + window.scrollY);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [ref]);

  return top;
};
