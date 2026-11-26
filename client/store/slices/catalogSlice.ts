import { createSlice } from "@reduxjs/toolkit";
import type { EventType } from "@shared/api";
import { api } from "@/lib/api";
import { createApiThunk } from "@/lib/portalThunk";

export const fetchEventTypes = createApiThunk("catalog/fetch", async () => (await api.get<{ items: EventType[] }>("/event-types")).data.items);

const slice = createSlice({
  name: "catalog",
  initialState: { items: [] as EventType[], loaded: false, loading: false, error: null as string | null },
  reducers: {},
  extraReducers: (b) =>
    b
      .addCase(fetchEventTypes.pending, (s) => {
        s.loading = true;
      })
      .addCase(fetchEventTypes.fulfilled, (s, a) => {
        s.items = a.payload;
        s.loaded = true;
        s.loading = false;
      })
      .addCase(fetchEventTypes.rejected, (s, a) => {
        s.loading = false;
        s.error = a.payload ?? "errors.server";
      }),
});
export default slice.reducer;
