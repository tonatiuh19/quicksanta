import { createSlice } from "@reduxjs/toolkit";
import type { CheckoutSession, EventRow, ExclusionRow, MyAssignment, PricingInfo, TenantDashboard } from "@shared/api";
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

// ── Pro checkout (Stripe) ──
export const fetchPricing = createApiThunk("app/pricing", async () => (await api.get<PricingInfo & { ok: true }>("/pricing")).data);
export const startCheckout = createApiThunk("app/startCheckout", async (eventId: number) => (await api.post<CheckoutSession>(`/app/events/${eventId}/checkout`, {})).data);
export const confirmCheckout = createApiThunk("app/confirmCheckout", async (arg: { eventId: number; paymentIntentId: string }) =>
  (await api.post<{ event: EventRow }>(`/app/events/${arg.eventId}/checkout/confirm`, { payment_intent_id: arg.paymentIntentId })).data.event,
);

interface AppState {
  dashboard: TenantDashboard | null;
  detail: EventDetail | null;
  myEvents: MyEventRow[];
  my: MyAssignment | null;
  pricing: PricingInfo | null;
  loading: Record<string, boolean>;
  error: string | null;
  busy: boolean;
}
const initialState: AppState = { dashboard: null, detail: null, myEvents: [], my: null, pricing: null, loading: {}, error: null, busy: false };

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
    track(resetDraw, "busy", () => undefined);
    track(addParticipants, "busy", () => undefined);
    track(saveWishlist, "busy", (s, p) => void (s.my && (s.my.me.wishlist = p)));
    track(updateParticipant, "busy", () => undefined);
    track(resendInvite, "busy", () => undefined);
    track(addExclusion, "busy", () => undefined);
    track(removeExclusion, "busy", () => undefined);
    track(updateMember, "busy", () => undefined);
    track(fetchPricing, "pricing", (s, p) => void (s.pricing = p));
    track(confirmCheckout, "busy", (s, p) => void (s.detail && s.detail.event.id === p.id && (s.detail.event = p)));
  },
});

export const { clearAppError } = slice.actions;
export default slice.reducer;

// ── Invitations (public preview + respond) ──
export type InvitePreview = { name: string; email_hint: string; event_name: string; event_status: string; type_name: string; exchange_date: string | null; budget: string | null; tenant_name: string; status: string };
export const fetchInvite = createApiThunk("app/fetchInvite", async (token: string) => (await api.get<{ invite: InvitePreview }>(`/join/${token}`)).data.invite);
export const respondInvite = createApiThunk("app/respondInvite", async (arg: { token: string; accept: boolean }) => (await api.post<{ status: string; tenant_id: number; event_public_id: string }>(`/join/${arg.token}/respond`, { accept: arg.accept })).data);
