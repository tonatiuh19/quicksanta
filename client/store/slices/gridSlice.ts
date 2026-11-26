/**
 * Server-side grid factory. One slice per grid endpoint; the page dispatches
 * setQuery / setSort / setPage / setSearch / setFilter and then `fetch`.
 * All filtering, sorting, search and pagination happen in SQL (api/index.ts parseGridQuery).
 */
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { gridQueryToParams, type GridQuery, type PaginationInfo } from "@shared/api";
import { api } from "@/lib/api";
import { createApiThunk } from "@/lib/portalThunk";

export interface GridState<T> {
  items: T[];
  pagination: PaginationInfo | null;
  query: GridQuery;
  loading: boolean;
  error: string | null;
  /** Bumps on every fetch so stale responses are ignored. */
  requestId: string | null;
}

export function createGridSlice<T>(name: string, endpoint: string | ((arg: any) => string), defaults: Partial<GridQuery> = {}) {
  const initialQuery: GridQuery = { page: 1, limit: 25, sortDir: "DESC", filters: {}, q: "", ...defaults };
  const initialState: GridState<T> = { items: [], pagination: null, query: initialQuery, loading: false, error: null, requestId: null };

  const fetchGrid = createApiThunk(`${name}/fetch`, async (arg: { query: GridQuery; pathArg?: unknown }) => {
    const url = typeof endpoint === "function" ? endpoint(arg.pathArg) : endpoint;
    const { data } = await api.get<{ items: T[]; pagination: PaginationInfo }>(url, { params: gridQueryToParams(arg.query) });
    return data;
  });

  const slice = createSlice({
    name,
    initialState,
    reducers: {
      setPage(s, a: PayloadAction<number>) {
        s.query.page = Math.max(1, a.payload);
      },
      setLimit(s, a: PayloadAction<number>) {
        s.query.limit = a.payload;
        s.query.page = 1;
      },
      setSearch(s, a: PayloadAction<string>) {
        s.query.q = a.payload;
        s.query.page = 1;
      },
      setFilter(s, a: PayloadAction<{ key: string; value: string }>) {
        s.query.filters = { ...(s.query.filters ?? {}), [a.payload.key]: a.payload.value };
        s.query.page = 1;
      },
      /** Click a sortable header: same column toggles direction, new column starts ASC. */
      toggleSort(s, a: PayloadAction<string>) {
        if (s.query.sortBy === a.payload) s.query.sortDir = s.query.sortDir === "ASC" ? "DESC" : "ASC";
        else {
          s.query.sortBy = a.payload;
          s.query.sortDir = "ASC";
        }
        s.query.page = 1;
      },
      resetQuery(s) {
        s.query = initialQuery;
      },
    },
    extraReducers: (b) => {
      b.addCase(fetchGrid.pending, (s, a) => {
        s.loading = true;
        s.error = null;
        s.requestId = a.meta.requestId;
      })
        .addCase(fetchGrid.fulfilled, (s, a) => {
          if (s.requestId !== a.meta.requestId) return;
          s.loading = false;
          s.items = a.payload.items as any;
          s.pagination = a.payload.pagination;
        })
        .addCase(fetchGrid.rejected, (s, a) => {
          if (s.requestId !== a.meta.requestId) return;
          s.loading = false;
          s.error = a.payload ?? "errors.server";
        });
    },
  });

  return { reducer: slice.reducer, actions: slice.actions, fetch: fetchGrid, initialState };
}
