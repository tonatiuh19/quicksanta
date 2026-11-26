/**
 * Redux-bound server-side grid: toolbar (search + whitelisted filters) + DataGrid (sort + pagination).
 * Every list in the app uses this; all filtering/sorting/paging runs in SQL.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DataGrid, type DataGridColumn } from "@/components/ui/data-grid";
import { ErrorNote, FilterSelect, SearchBox } from "@/components/kit";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { grids, type GridKey } from "@/store/slices/grids";

export type GridFilter = { key: string; label: string; options: Array<{ value: string; label: string }> };

export default function ServerGrid<T>({
  grid,
  columns,
  rowKey,
  filters = [],
  pathArg,
  onRowClick,
  mobileCard,
  toolbarExtra,
  searchPlaceholder,
  emptyMessage,
  reloadToken,
}: {
  grid: GridKey;
  columns: DataGridColumn<T>[];
  rowKey: (row: T) => string | number;
  filters?: GridFilter[];
  pathArg?: unknown;
  onRowClick?: (row: T) => void;
  mobileCard?: (row: T) => ReactNode;
  toolbarExtra?: ReactNode;
  searchPlaceholder?: string;
  emptyMessage?: string;
  /** Change to force a refetch (after a mutation). */
  reloadToken?: unknown;
}) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const g = grids[grid];
  const state = useAppSelector((s) => s[grid]) as unknown as { items: T[]; pagination: any; query: any; loading: boolean; error: string | null };
  const { query } = state;

  // Another exchange (pathArg) → drop the previous one's rows, page and search before fetching.
  const lastArg = useRef(pathArg);
  useEffect(() => {
    if (lastArg.current !== pathArg) {
      lastArg.current = pathArg;
      dispatch(g.actions.reset());
    }
  }, [pathArg, dispatch, g]);

  useEffect(() => {
    void dispatch(g.fetch({ query, pathArg }) as any);
  }, [dispatch, g, query, pathArg, reloadToken]);

  return (
    <div className="qs-grid">
      <div className="qs-grid-toolbar">
        <SearchBox value={query.q ?? ""} onSearch={(q) => dispatch(g.actions.setSearch(q))} placeholder={searchPlaceholder} />
        {filters.map((f) => (
          <FilterSelect key={f.key} label={f.label} value={query.filters?.[f.key] ?? "all"} options={f.options} onChange={(value) => dispatch(g.actions.setFilter({ key: f.key, value }))} />
        ))}
        {toolbarExtra ? <div className="qs-grid-extra">{toolbarExtra}</div> : null}
      </div>
      <ErrorNote error={state.error} onRetry={() => void dispatch(g.fetch({ query, pathArg }) as any)} />
      <div className="qs-grid-body">
        <DataGrid<T>
          data={state.items}
          columns={columns}
          rowKey={rowKey}
          sortBy={query.sortBy}
          sortDir={query.sortDir}
          onSort={(key) => dispatch(g.actions.toggleSort(key))}
          pagination={state.pagination}
          onPageChange={(p) => dispatch(g.actions.setPage(p))}
          isLoading={state.loading && state.items.length === 0}
          emptyMessage={emptyMessage ?? t("grid.empty")}
          onRowClick={onRowClick}
          mobileCard={mobileCard}
          noBleeding
        />
      </div>
    </div>
  );
}
