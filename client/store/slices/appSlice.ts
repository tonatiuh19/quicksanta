import { createSlice } from "@reduxjs/toolkit";
import type { BillingOverview, CancelReason, InviteLinkInfo, JoinCodePreview, ExchangeTemplate, ParticipantRow, EventRow, ExclusionRow, MyAssignment, PricingInfo, TenantDashboard } from "@shared/api";
import { api } from "@/lib/api";
import { createApiThunk } from "@/lib/portalThunk";

export type EventDetail = { event: EventRow; uses_draw: boolean; max_participants: number; pricing: PricingInfo; tenant_plan: string; exclusions: ExclusionRow[]; assignments: { total: number; viewed: number } };
export type MyEventRow = EventRow & { tenant_name: string };

export const fetchDashboard = createApiThunk("app/dashboard", async () => (await api.get<TenantDashboard>("/app/dashboard")).data);
export const fetchEventDetail = createApiThunk("app/eventDetail", async (id: number) => (await api.get<EventDetail>(`/app/events/${id}`)).data);
export const updateEvent = createApiThunk("app/updateEvent", async (arg: { id: number; patch: Record<string, unknown> }) => (await api.patch<{ event: EventRow }>(`/app/events/${arg.id}`, arg.patch)).data.event);
export const addParticipants = createApiThunk("app/addParticipants", async (arg: { id: number; participants: Array<{ name: string; email: string }>; send_invites: boolean }) => (await api.post<{ added: number; invited: number; skipped: number }>(`/app/events/${arg.id}/participants`, arg)).data);
export const updateParticipant = createApiThunk("app/updateParticipant", async (arg: { eventId: number; id: number; patch: { name?: string; status?: string } }) => {
  await api.patch(`/app/events/${arg.eventId}/participants/${arg.id}`, arg.patch);
  return arg;
});
export const resendInvite = createApiThunk("app/resendInvite", async (arg: { eventId: number; id: number }) => {
  await api.post(`/app/events/${arg.eventId}/participants/${arg.id}/resend`);
  return arg;
});
export const addExclusion = createApiThunk("app/addExclusion", async (arg: { eventId: number; giver_participant_id: number; receiver_participant_id: number; bidirectional: boolean }) => {
  await api.post(`/app/events/${arg.eventId}/exclusions`, arg);
  return arg;
});
export const removeExclusion = createApiThunk("app/removeExclusion", async (arg: { eventId: number; id: number }) => {
  await api.delete(`/app/events/${arg.eventId}/exclusions/${arg.id}`);
  return arg;
});
/** Remind everyone still "invited" (fresh join link; once per exchange per day). */
export const remindPending = createApiThunk("app/remindPending", async (id: number) => (await api.post<{ reminded: number; pending: number }>(`/app/events/${id}/remind`, {})).data);
export const runDraw = createApiThunk("app/draw", async (id: number) => (await api.post<{ assigned: number; notified: number }>(`/app/events/${id}/draw`, {})).data);
export const resetDraw = createApiThunk("app/resetDraw", async (id: number) => {
  await api.post(`/app/events/${id}/reset-draw`);
});
export const fetchMyEvents = createApiThunk("app/myEvents", async () => (await api.get<{ items: MyEventRow[] }>("/app/my/events")).data.items);
export const fetchMyAssignment = createApiThunk("app/myAssignment", async (publicId: string) => (await api.get<MyAssignment>(`/app/my/events/${publicId}`)).data);
export const saveWishlist = createApiThunk("app/saveWishlist", async (arg: { publicId: string; wishlist: string }) => {
  await api.put(`/app/my/events/${arg.publicId}/wishlist`, { wishlist: arg.wishlist });
  return arg.wishlist;
});
export const updateMember = createApiThunk("app/updateMember", async (arg: { id: number; role?: string; remove?: boolean }) => {
  await api.patch(`/app/members/${arg.id}`, arg);
});
export const updateTenant = createApiThunk("app/updateTenant", async (arg: { name?: string; locale?: string }) => {
  await api.patch("/app/tenant", arg);
  return arg;
});

// ── Invite link (organizer) + join with a code (anyone, after signing in) ──
export const fetchInviteLink = createApiThunk("app/inviteLink", async (eventId: number) => ({ eventId, link: (await api.get<{ link: InviteLinkInfo }>(`/app/events/${eventId}/invite-link`)).data.link }));
export const updateInviteLink = createApiThunk("app/updateInviteLink", async (arg: { eventId: number; patch: { enabled?: boolean; max?: number | null; expires_at?: string | null } }) => ({
  eventId: arg.eventId,
  link: (await api.put<{ link: InviteLinkInfo }>(`/app/events/${arg.eventId}/invite-link`, arg.patch)).data.link,
}));
export const regenerateInviteLink = createApiThunk("app/regenerateInviteLink", async (eventId: number) => ({ eventId, link: (await api.post<{ link: InviteLinkInfo }>(`/app/events/${eventId}/invite-link/regenerate`, {})).data.link }));
/** Code-scoped preview: the page keeps it in local state (nothing else reads it). */
export const fetchJoinCode = createApiThunk("app/fetchJoinCode", async (code: string) => (await api.get<{ preview: JoinCodePreview }>(`/join-code/${encodeURIComponent(code)}`)).data.preview);
export const joinWithCode = createApiThunk("app/joinWithCode", async (arg: { code: string; name?: string }) =>
  (await api.post<{ status: "joined"; already: boolean; tenant_id: number; event_public_id: string }>(`/join-code/${encodeURIComponent(arg.code)}`, arg.name ? { name: arg.name } : {})).data,
);

/** Landing-page Enterprise contact form (public). */
export const submitContact = createApiThunk("app/submitContact", async (body: import("@shared/api").ContactRequestInput) => {
  await api.post("/contact", body);
});

// ── Pro checkout (Stripe) ──
export const fetchPricing = createApiThunk("app/pricing", async () => (await api.get<PricingInfo & { ok: true }>("/pricing")).data);
/** Every invited/joined person of an exchange (walks all grid pages) — for pickers that must see everyone. */
export const fetchEventPeople = createApiThunk("app/eventPeople", async (eventId: number) => {
  const all: ParticipantRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data } = await api.get<{ items: ParticipantRow[]; pagination: { totalPages: number } }>(`/app/events/${eventId}/participants`, { params: { page, limit: 100, sort_by: "name", sort_dir: "ASC" } });
    all.push(...data.items.filter((p) => p.status === "invited" || p.status === "joined"));
    if (page >= data.pagination.totalPages) break;
  }
  return { eventId, people: all };
});

// ── Custom exchange templates ──
export const fetchTemplates = createApiThunk("app/templates", async () => (await api.get<{ items: ExchangeTemplate[] }>("/app/templates")).data.items);
export const deleteTemplate = createApiThunk("app/deleteTemplate", async (id: number) => {
  await api.delete(`/app/templates/${id}`);
  return id;
});

// ── Billing (Pro subscription per workspace) ──
export const fetchBilling = createApiThunk("app/billing", async () => (await api.get<BillingOverview & { ok: true }>("/app/billing")).data);
export const startSubscription = createApiThunk("app/subscribe", async () => (await api.post<{ client_secret: string; subscription_id: string }>("/app/billing/subscribe", {})).data);
export const syncSubscription = createApiThunk("app/syncSubscription", async () => (await api.post<{ status: string; plan: string }>("/app/billing/sync", {})).data);
export const startCardUpdate = createApiThunk("app/startCardUpdate", async () => (await api.post<{ client_secret: string }>("/app/billing/payment-method/setup", {})).data);
export const saveCard = createApiThunk("app/saveCard", async (paymentMethodId: string) => (await api.post<{ card: { brand: string; last4: string; exp: string }; retried: string | null }>("/app/billing/payment-method", { payment_method_id: paymentMethodId })).data);
export const acceptSaveOffer = createApiThunk("app/saveOffer", async () => (await api.post<{ percent: number }>("/app/billing/save-offer", {})).data);
export const cancelSubscription = createApiThunk("app/cancelSubscription", async (arg: { reason: CancelReason; feedback: string; confirm_name: string }) =>
  (await api.post<{ current_period_end: string | null }>("/app/billing/cancel", arg)).data,
);
export const resumeSubscription = createApiThunk("app/resumeSubscription", async () => {
  await api.post("/app/billing/resume", {});
});

interface AppState {
  dashboard: TenantDashboard | null;
  detail: EventDetail | null;
  myEvents: MyEventRow[];
  my: MyAssignment | null;
  pricing: PricingInfo | null;
  billing: BillingOverview | null;
  templates: ExchangeTemplate[];
  people: { eventId: number; people: ParticipantRow[] } | null;
  inviteLink: { eventId: number; link: InviteLinkInfo } | null;
  loading: Record<string, boolean>;
  error: string | null;
  busy: boolean;
}
const initialState: AppState = { dashboard: null, detail: null, myEvents: [], my: null, pricing: null, billing: null, templates: [], people: null, inviteLink: null, loading: {}, error: null, busy: false };

const slice = createSlice({
  name: "app",
  initialState,
  reducers: {
    clearAppError(s) {
      s.error = null;
    },
  },
  extraReducers: (b) => {
    const track = (thunk: any, key: string, onOk: (s: AppState, payload: any) => void) =>
      b
        .addCase(thunk.pending, (s: AppState) => {
          s.loading[key] = true;
          s.error = null;
        })
        .addCase(thunk.fulfilled, (s: AppState, a: any) => {
          s.loading[key] = false;
          onOk(s, a.payload);
        })
        .addCase(thunk.rejected, (s: AppState, a: any) => {
          s.loading[key] = false;
          s.error = a.payload ?? "errors.server";
        });
    track(fetchDashboard, "dashboard", (s, p) => void (s.dashboard = p));
    track(fetchEventDetail, "detail", (s, p) => void (s.detail = p));
    track(fetchMyEvents, "myEvents", (s, p) => void (s.myEvents = p));
    track(fetchMyAssignment, "my", (s, p) => void (s.my = p));
    track(updateEvent, "busy", (s, p) => void (s.detail && (s.detail.event = p)));
    track(runDraw, "busy", () => undefined);
    track(remindPending, "busy", () => undefined);
    track(resetDraw, "busy", () => undefined);
    track(addParticipants, "busy", () => undefined);
    track(saveWishlist, "busy", (s, p) => void (s.my && (s.my.me.wishlist = p)));
    track(updateParticipant, "busy", () => undefined);
    track(resendInvite, "busy", () => undefined);
    track(addExclusion, "busy", () => undefined);
    track(removeExclusion, "busy", () => undefined);
    track(updateMember, "busy", () => undefined);
    track(fetchPricing, "pricing", (s, p) => void (s.pricing = p));
    track(fetchBilling, "billing", (s, p) => void (s.billing = p));
    track(fetchTemplates, "templates", (s, p) => void (s.templates = p));
    track(fetchEventPeople, "people", (s, p) => void (s.people = p));
    track(fetchInviteLink, "inviteLink", (s, p) => void (s.inviteLink = p));
    track(updateInviteLink, "inviteLinkBusy", (s, p) => void (s.inviteLink = p));
    track(regenerateInviteLink, "inviteLinkBusy", (s, p) => void (s.inviteLink = p));
    track(deleteTemplate, "busy", (s, id) => void (s.templates = s.templates.filter((x) => x.id !== id)));
    track(acceptSaveOffer, "busy", () => undefined);
    track(cancelSubscription, "busy", () => undefined);
    track(resumeSubscription, "busy", () => undefined);
  },
});

export const { clearAppError } = slice.actions;
export default slice.reducer;

// ── Invitations (public preview + respond) ──
export type InvitePreview = { name: string; email_hint: string; event_name: string; event_status: string; type_name: string; theme_rules?: string | null; exchange_date: string | null; budget: string | null; tenant_name: string; status: string };
export const fetchInvite = createApiThunk("app/fetchInvite", async (token: string) => (await api.get<{ invite: InvitePreview }>(`/join/${token}`)).data.invite);
export const respondInvite = createApiThunk("app/respondInvite", async (arg: { token: string; accept: boolean }) => (await api.post<{ status: string; tenant_id: number; event_public_id: string }>(`/join/${arg.token}/respond`, { accept: arg.accept })).data);
