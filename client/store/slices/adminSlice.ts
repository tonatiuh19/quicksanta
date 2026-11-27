import { createSlice } from "@reduxjs/toolkit";
import type { AdminTenantRow, CommandCenterOverview, EventRow, EventType } from "@shared/api";
import { api } from "@/lib/api";
import { createApiThunk } from "@/lib/portalThunk";

export type TenantDetail = { tenant: AdminTenantRow; members: Array<{ id: number; user_id: number; email: string; full_name: string; role: string; status: string; created_at: string }>; events: EventRow[] };
export type AdminEventType = EventType & { usage_count: number };
export type SettingRow = { setting_key: string; setting_value: string | null; description: string | null; updated_at: string };

export const updateLead = createApiThunk("admin/updateLead", async (arg: { id: number; patch: { status?: string; notes?: string | null } }) => {
  await api.patch(`/admin/leads/${arg.id}`, arg.patch);
  return arg;
});
// ── Email gallery (every template with sample data) ──
export type EmailPreview = { key: string; lang: "en" | "es"; subject: string; html: string; text: string };
export const fetchEmailPreviews = createApiThunk("admin/emailPreviews", async () => (await api.get<{ items: Array<{ key: string; subject: string }> }>("/admin/email-previews")).data.items);
export const fetchEmailPreview = createApiThunk("admin/emailPreview", async (arg: { key: string; lang: "en" | "es" }) => {
  const d = (await api.get<{ subject: string; html: string; text: string }>(`/admin/email-previews/${encodeURIComponent(arg.key)}`, { params: { lang: arg.lang } })).data;
  return { ...arg, subject: d.subject, html: d.html, text: d.text } as EmailPreview;
});
export const sendTestEmail = createApiThunk("admin/sendTestEmail", async (arg: { key: string; lang: "en" | "es" }) =>
  (await api.post<{ ok: boolean; dry_run: boolean; to: string }>(`/admin/email-previews/${encodeURIComponent(arg.key)}/send`, { lang: arg.lang })).data,
);

export const fetchOverview = createApiThunk("admin/overview", async () => (await api.get<CommandCenterOverview>("/admin/overview")).data);
export const fetchTenantDetail = createApiThunk("admin/tenantDetail", async (id: number) => (await api.get<TenantDetail>(`/admin/tenants/${id}`)).data);
export const updateTenantAdmin = createApiThunk("admin/updateTenant", async (arg: { id: number; patch: Record<string, unknown> }) => {
  await api.patch(`/admin/tenants/${arg.id}`, arg.patch);
  return arg;
});
export const updateUserAdmin = createApiThunk("admin/updateUser", async (arg: { id: number; patch: Record<string, unknown> }) => {
  await api.patch(`/admin/users/${arg.id}`, arg.patch);
  return arg;
});
export const grantPlatformRole = createApiThunk("admin/grant", async (arg: { email: string; full_name: string; platform_role: "owner" | "admin" }) => {
  await api.post("/admin/users/invite", arg);
});
export const fetchAdminCatalog = createApiThunk("admin/catalog", async () => (await api.get<{ items: AdminEventType[] }>("/admin/event-types")).data.items);
export const saveEventType = createApiThunk("admin/saveEventType", async (arg: { id?: number; data: Partial<EventType> }) => {
  if (arg.id) await api.patch(`/admin/event-types/${arg.id}`, arg.data);
  else await api.post("/admin/event-types", arg.data);
});
export const fetchSettings = createApiThunk("admin/settings", async () => (await api.get<{ items: SettingRow[] }>("/admin/settings")).data.items);
export const saveSettings = createApiThunk("admin/saveSettings", async (values: Record<string, string>) => {
  await api.put("/admin/settings", values);
  return values;
});

interface AdminState {
  overview: CommandCenterOverview | null;
  tenantDetail: TenantDetail | null;
  catalog: AdminEventType[];
  settings: SettingRow[];
  emailPreviews: Array<{ key: string; subject: string }>;
  emailPreview: EmailPreview | null;
  loading: Record<string, boolean>;
  error: string | null;
}
const initialState: AdminState = { overview: null, tenantDetail: null, catalog: [], settings: [], emailPreviews: [], emailPreview: null, loading: {}, error: null };

const slice = createSlice({
  name: "admin",
  initialState,
  reducers: {
    closeTenantDetail(s) {
      s.tenantDetail = null;
    },
    clearAdminError(s) {
      s.error = null;
    },
  },
  extraReducers: (b) => {
    const track = (thunk: any, key: string, onOk: (s: AdminState, p: any) => void) =>
      b
        .addCase(thunk.pending, (s: AdminState) => {
          s.loading[key] = true;
          s.error = null;
        })
        .addCase(thunk.fulfilled, (s: AdminState, a: any) => {
          s.loading[key] = false;
          onOk(s, a.payload);
        })
        .addCase(thunk.rejected, (s: AdminState, a: any) => {
          s.loading[key] = false;
          s.error = a.payload ?? "errors.server";
        });
    track(fetchOverview, "overview", (s, p) => void (s.overview = p));
    track(fetchEmailPreviews, "emailPreviews", (s, p) => void (s.emailPreviews = p));
    track(fetchEmailPreview, "emailPreview", (s, p) => void (s.emailPreview = p));
    track(sendTestEmail, "sendTest", () => undefined);
    track(fetchTenantDetail, "tenant", (s, p) => void (s.tenantDetail = p));
    track(updateTenantAdmin, "save", (s, p) => {
      if (s.tenantDetail?.tenant.id === p.id) Object.assign(s.tenantDetail.tenant, p.patch);
    });
    track(updateUserAdmin, "save", () => undefined);
    track(grantPlatformRole, "save", () => undefined);
    track(fetchAdminCatalog, "catalog", (s, p) => void (s.catalog = p));
    track(saveEventType, "save", () => undefined);
    track(fetchSettings, "settings", (s, p) => void (s.settings = p));
    track(saveSettings, "save", (s, p) => {
      for (const row of s.settings) if (p[row.setting_key] !== undefined) row.setting_value = p[row.setting_key];
    });
  },
});

export const { closeTenantDetail, clearAdminError } = slice.actions;
export default slice.reducer;
