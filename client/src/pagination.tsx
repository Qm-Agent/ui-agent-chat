import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE_OPTIONS = [10, 30, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export interface PaginationState<T> {
  page: number;
  pageSize: PageSize;
  totalItems: number;
  totalPages: number;
  pagedItems: T[];
  setPage: (page: number) => void;
  setPageSize: (pageSize: PageSize) => void;
}

export function usePagination<T>(items: T[], defaultSize: PageSize = 30): PaginationState<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState<PageSize>(defaultSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const visiblePage = Math.min(page, totalPages);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedItems = useMemo(() => {
    const start = (visiblePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, pageSize, visiblePage]);

  const setPageSize = useCallback((nextPageSize: PageSize) => {
    setPageSizeRaw(nextPageSize);
    setPage(1);
  }, []);

  return { page: visiblePage, pageSize, totalItems, totalPages, pagedItems, setPage, setPageSize };
}

export function Pagination<T>({ state }: { state: PaginationState<T> }) {
  if (state.totalItems === 0) return null;
  return (
    <div className="pagination-bar">
      <span className="pagination-info">共 {state.totalItems} 条，第 {state.page}/{state.totalPages} 页</span>
      <div className="pagination-controls">
        <button className="pagination-btn" type="button" title="上一页" disabled={state.page <= 1} onClick={() => state.setPage(state.page - 1)}>
          <ChevronLeft size={14} />
        </button>
        <button className="pagination-btn" type="button" title="下一页" disabled={state.page >= state.totalPages} onClick={() => state.setPage(state.page + 1)}>
          <ChevronRight size={14} />
        </button>
        <select className="pagination-size" aria-label="每页条数" value={state.pageSize} onChange={(event) => state.setPageSize(Number(event.target.value) as PageSize)}>
          {PAGE_SIZE_OPTIONS.map((pageSize) => <option key={pageSize} value={pageSize}>{pageSize} 条/页</option>)}
        </select>
      </div>
    </div>
  );
}
