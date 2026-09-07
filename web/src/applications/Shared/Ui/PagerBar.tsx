'use client';

import { Pagination } from '@heroui/react';

interface PageItem {
  key: string;
  page: number | null;
}

/** First page, last page and the current page's neighbours, with ellipsis gaps between. */
const pageWindow = (page: number, pages: number): PageItem[] => {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, i) => ({ key: `page-${i + 1}`, page: i + 1 }));
  }
  const around = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const first = around.at(0);
  const last = around.at(-1);
  const items: PageItem[] = [{ key: 'page-1', page: 1 }];
  if (first != null && first > 2) items.push({ key: 'gap-start', page: null });
  for (const p of around) items.push({ key: `page-${p}`, page: p });
  if (last != null && last < pages - 1) items.push({ key: 'gap-end', page: null });
  items.push({ key: `page-${pages}`, page: pages });
  return items;
};

interface PagerBarProps {
  page: number;
  pages: number;
  onPageChange: (page: number) => void;
  /** Names the control for screen readers, e.g. "History pages". */
  label: string;
  /** Numbered page links between the arrows. Off on phones, where they do not fit. */
  numbered?: boolean;
}

/**
 * The app's only pager: a page-of-pages summary between Previous and Next, optionally with numbered
 * links. Renders nothing for a single page, so callers mount it unconditionally instead of each
 * repeating the same guard.
 */
export const PagerBar = ({ page, pages, onPageChange, label, numbered }: PagerBarProps) => {
  if (pages <= 1) return null;

  return (
    <Pagination.Root size="sm" aria-label={label}>
      <Pagination.Summary>
        <span className="tabular">
          Page {page} of {pages}
        </span>
      </Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous
            className="size-11 md:size-8"
            isDisabled={page <= 1}
            onPress={() => onPageChange(page - 1)}
          >
            <Pagination.PreviousIcon />
            <span className="sr-only">Previous page</span>
          </Pagination.Previous>
        </Pagination.Item>
        {numbered &&
          pageWindow(page, pages).map((item) => (
            <Pagination.Item key={item.key}>
              {item.page == null ? (
                <Pagination.Ellipsis />
              ) : (
                <Pagination.Link
                  className="size-11 md:size-8"
                  isActive={item.page === page}
                  aria-label={`Page ${item.page}`}
                  onPress={() => onPageChange(item.page ?? 1)}
                >
                  <span className="tabular">{item.page}</span>
                </Pagination.Link>
              )}
            </Pagination.Item>
          ))}
        <Pagination.Item>
          <Pagination.Next
            className="size-11 md:size-8"
            isDisabled={page >= pages}
            onPress={() => onPageChange(page + 1)}
          >
            <span className="sr-only">Next page</span>
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination.Root>
  );
};
